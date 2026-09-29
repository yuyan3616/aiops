import type {
  ChatMessage,
  ConversationConfigUpdate,
  ConversationInvestigationSnapshot,
  ConversationSummary,
  MessageListItem,
  StreamEvent,
  PersonalModelInput,
} from "@shared/types";
import { useRef, useState, useEffect, useReducer } from "react";
import { useNavigate } from "react-router-dom";

import {
  abortConversation,
  connectEvents,
  createConversation,
  getConversation,
  sendMessage,
  updateConversationConfig,
} from "@/api";
import { conversationReducer, createRuntimeState, runtimeReducer } from "@/state";

interface PendingSend {
  conversationId: string;
  text: string;
  message: ChatMessage;
  skills?: string[];
  personalModel?: PersonalModelInput;
}

interface ConversationItemsState {
  conversationId?: string;
  items: MessageListItem[];
}

export function useConversationStream(conversationId?: string) {
  const navigate = useNavigate();
  const [messageState, setMessageState] = useState<ConversationItemsState>({
    items: [],
  });
  const [historyState, setHistoryState] = useState<ConversationItemsState>({
    items: [],
  });
  const [errorState, setErrorState] = useState<{
    conversationId?: string;
    message: string;
  }>({ message: "" });
  const [loading, setLoading] = useState(false);
  const [visualizationRevision, setVisualizationRevision] = useState(0);
  const [investigation, setInvestigation] = useState<ConversationInvestigationSnapshot>();
  const [conversationMeta, setConversationMeta] = useState<{
    conversationId?: string;
    conversation?: ConversationSummary;
  }>({});
  const [runtime, dispatch] = useReducer(runtimeReducer, conversationId, createRuntimeState);
  const actionInFlight = useRef(new Set<string>());
  const resync = useRef<() => Promise<void>>(async () => {});
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const pendingSend = useRef<PendingSend | null>(null);

  useEffect(() => {
    dispatch({ type: "select", conversationId });
    setVisualizationRevision(0);
    setInvestigation(undefined);
  }, [conversationId]);

  const messageItems = [
    ...(historyState.conversationId === conversationId ? historyState.items : []),
    ...(messageState.conversationId === conversationId ? messageState.items : []),
  ];

  useEffect(() => {
    if (!conversationId) return;

    let disposed = false;
    let eventSource: EventSource | undefined;
    let streamOpen = false;
    let syncing = true;
    let syncVersion = 0;
    let buffered: StreamEvent[] = [];
    let cursor = { id: "", lastEventId: 0 };
    let runtimeEventId = 0;
    const receive = (event: StreamEvent) => {
      if (disposed) return;
      if (syncing) {
        buffered.push(event);
        return;
      }
      if (event.streamId !== cursor.id || event.id <= cursor.lastEventId) return;
      cursor = { id: event.streamId, lastEventId: event.id };
      // Replayed messages must not roll runtime state back behind its latest snapshot.
      if (event.id > runtimeEventId) dispatch({ type: "event", conversationId, event });
      if (event.type === "conversation.updated") {
        const conversation = (event.payload as { conversation?: ConversationSummary }).conversation;
        if (conversation?.id === conversationId) {
          setConversationMeta({ conversationId, conversation });
        }
      }
      if (event.type === "visualization.updated") {
        setVisualizationRevision((current) => current + 1);
      }
      if (event.type === "investigation.updated") {
        const payload = event.payload as Partial<ConversationInvestigationSnapshot>;
        if (payload.investigationId && payload.state) {
          setInvestigation(
            (current) =>
              ({
                ...(current?.investigationId === payload.investigationId ? current : {}),
                ...payload,
              }) as ConversationInvestigationSnapshot,
          );
        }
      }
      setMessageState((current) => ({
        conversationId,
        items: conversationReducer(current.conversationId === conversationId ? current.items : [], {
          type: "event",
          event,
        }),
      }));
    };
    const disconnect = () => {
      if (disposed) return;
      streamOpen = false;
      syncVersion++;
      syncing = true;
      buffered = [];
      dispatch({ type: "disconnect", conversationId });
      setErrorState({ conversationId, message: "连接中断，正在重新同步…" });
    };
    const sync = async () => {
      if (disposed || !streamOpen) return;
      const version = ++syncVersion;
      syncing = true;
      dispatch({ type: "disconnect", conversationId });
      try {
        const conversation = await getConversation(conversationId);
        if (disposed || version !== syncVersion) return;
        if (cursor.id !== conversation.stream.id) {
          setHistoryState({ conversationId, items: conversation.messageList });
          setMessageState({ conversationId, items: [] });
          cursor = conversation.stream;
        }
        runtimeEventId = conversation.stream.lastEventId;
        dispatch({ type: "snapshot", conversationId, snapshot: conversation });
        setConversationMeta({
          conversationId,
          conversation: conversation.conversation,
        });
        setInvestigation(conversation.rca);
        setSelectedSkills(conversation.activeSkillNames ?? []);
        setErrorState({ conversationId, message: "" });
        syncing = false;
        const events = buffered;
        buffered = [];
        events.forEach(receive);
      } catch (error) {
        if (disposed || version !== syncVersion) return;
        setErrorState({ conversationId, message: (error as Error).message });
        // Let EventSource retry instead of leaving an open but unsynchronized connection.
        eventSource?.close();
        streamOpen = false;
        retryTimer = setTimeout(connect, 2000);
      }
    };
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      if (disposed) return;
      eventSource = connectEvents(
        conversationId,
        receive,
        disconnect,
        async () => {
          streamOpen = true;
          await sync();
          if (disposed || syncing) return;
          const pending = pendingSend.current;
          if (!pending || pending.conversationId !== conversationId) return;
          pendingSend.current = null;
          setMessageState((current) => ({
            conversationId,
            items: conversationReducer(
              current.conversationId === conversationId ? current.items : [],
              { type: "optimistic-user", message: pending.message },
            ),
          }));
          void send(conversationId, pending.text, pending.skills, pending.personalModel);
        },
        cursor.lastEventId,
      );
    };
    resync.current = sync;
    connect();

    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      eventSource?.close();
    };
  }, [conversationId]);

  async function send(
    conversationId: string,
    text: string,
    skills?: string[],
    personalModel?: PersonalModelInput,
  ) {
    setLoading(true);
    setErrorState({
      conversationId,
      message: "",
    });

    try {
      await sendMessage(conversationId, text, skills, personalModel);
    } catch (error) {
      setErrorState({
        conversationId,
        message: (error as Error)?.message || "Unknown error",
      });
    } finally {
      setLoading(false);
    }
  }

  async function submit(
    value: string,
    initialConfig?: ConversationConfigUpdate,
    skills?: string[],
    personalModel?: PersonalModelInput,
  ) {
    const text = value.trim();
    if (!text || loading) return;

    const message: ChatMessage = {
      id: "pending-" + Date.now(),
      role: "user",
      text,
      images: [],
      timestamp: Date.now(),
      pending: true,
    };
    if (!conversationId) {
      setLoading(true);
      setErrorState({
        message: "",
      });
      try {
        const created = await createConversation(personalModel);
        const conversationId = created.conversation.id;
        if (initialConfig?.model || initialConfig?.thinkingLevel !== undefined) {
          await updateConversationConfig(conversationId, initialConfig);
        }
        pendingSend.current = {
          conversationId,
          text,
          message,
          skills,
          personalModel,
        };
        navigate(`/conversation/${conversationId}`);
      } catch (error) {
        setErrorState({
          message: (error as Error)?.message || "Unknown error",
        });
      } finally {
        setLoading(false);
      }

      return;
    }

    setMessageState((current) => ({
      conversationId,
      items: conversationReducer(current.conversationId === conversationId ? current.items : [], {
        type: "optimistic-user",
        message,
      }),
    }));

    await send(conversationId, text, skills, personalModel);
  }
  const status = runtime.conversationId === conversationId ? runtime.status : "cold";
  const connectionError = errorState.conversationId === conversationId ? errorState.message : "";
  const runtimeError = runtime.conversationId === conversationId ? (runtime.error ?? "") : "";
  const error = connectionError || runtimeError;
  const historyLoading = Boolean(conversationId && historyState.conversationId !== conversationId);

  const abort = async () => {
    if (!conversationId || actionInFlight.current.has(conversationId)) return;
    const actionConversationId = conversationId;
    const refresh = resync.current;
    actionInFlight.current.add(actionConversationId);
    setErrorState({ conversationId: actionConversationId, message: "" });
    try {
      await abortConversation(actionConversationId);
      await refresh();
    } catch (error) {
      await refresh();
      setErrorState({
        conversationId: actionConversationId,
        message: (error as Error)?.message || "Unknown error",
      });
    } finally {
      actionInFlight.current.delete(actionConversationId);
    }
  };

  return {
    messageItems,
    historyLoading,
    loading,
    error,
    connectionError,
    runtimeError,
    send: submit,
    status,
    abort,
    selectedSkills,
    setSelectedSkills,
    conversationTitle:
      conversationMeta.conversationId === conversationId
        ? conversationMeta.conversation?.title
        : undefined,
    visualizationRevision,
    investigation,
  };
}
