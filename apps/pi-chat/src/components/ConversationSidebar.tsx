import { PiLogo } from "@components/PiLogo";
import { Button } from "@components/ui/button";
import type { ConversationSummary } from "@shared/types";
import {
  Check,
  Copy,
  ListChecks,
  MoreHorizontal,
  PanelLeftClose,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import {
  AlertDialog as AlertDialogPrimitive,
  DropdownMenu as DropdownMenuPrimitive,
} from "radix-ui";
import { useMemo, useState } from "react";

type ConversationGroupKey = "today" | "yesterday" | "week" | "month" | "older";

interface ConversationGroup {
  key: ConversationGroupKey;
  label: string;
  conversations: ConversationSummary[];
}

const GROUPS: Array<{ key: ConversationGroupKey; label: string }> = [
  { key: "today", label: "今天" },
  { key: "yesterday", label: "昨天" },
  { key: "week", label: "7 天内" },
  { key: "month", label: "30 天内" },
  { key: "older", label: "更早" },
];

function localDayNumber(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;
}

function conversationDate(item: ConversationSummary): Date {
  const updated = new Date(item.updatedAt);
  if (!Number.isNaN(updated.getTime())) return updated;
  return new Date(item.createdAt);
}

function groupKeyForDate(date: Date, now: Date): ConversationGroupKey {
  if (Number.isNaN(date.getTime())) return "older";
  const days = Math.max(0, localDayNumber(now) - localDayNumber(date));
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days <= 7) return "week";
  if (days <= 30) return "month";
  return "older";
}

export function groupConversationsByUpdatedAt(
  conversations: ConversationSummary[],
  now = new Date(),
): ConversationGroup[] {
  const buckets = new Map<ConversationGroupKey, ConversationSummary[]>(
    GROUPS.map(({ key }) => [key, []]),
  );
  const sorted = [...conversations].sort(
    (left, right) =>
      conversationDate(right).getTime() - conversationDate(left).getTime(),
  );
  for (const item of sorted) {
    buckets.get(groupKeyForDate(conversationDate(item), now))?.push(item);
  }
  return GROUPS.map(({ key, label }) => ({
    key,
    label,
    conversations: buckets.get(key) ?? [],
  })).filter((group) => group.conversations.length > 0);
}

function searchDateLabel(item: ConversationSummary, now = new Date()): string {
  const date = conversationDate(item);
  const group = groupKeyForDate(date, now);
  if (group === "today") return "今天";
  if (group === "yesterday") return "昨天";
  if (date.getFullYear() === now.getFullYear()) {
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  }
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

export function ConversationSidebar({
  conversations,
  selectedId,
  open,
  collapsed,
  onOpenChange,
  onCollapse,
  onNew,
  onSelect,
  onRename,
  onDelete,
  onDeleteMany,
}: {
  conversations: ConversationSummary[];
  selectedId?: string;
  open: boolean;
  collapsed: boolean;
  onOpenChange(open: boolean): void;
  onCollapse(): void;
  onNew(): Promise<void>;
  onSelect(id: string): void | Promise<void>;
  onRename(id: string, title: string): Promise<void>;
  onDelete(id: string): Promise<void>;
  onDeleteMany(ids: string[]): Promise<void>;
}) {
  const [editingId, setEditingId] = useState<string>();
  const [editingTitle, setEditingTitle] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<ConversationSummary>();
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
  const filteredConversations = useMemo(() => {
    if (!normalizedQuery) return conversations;
    return conversations.filter((item) =>
      item.title.toLocaleLowerCase().includes(normalizedQuery),
    );
  }, [conversations, normalizedQuery]);

  const groups = useMemo(
    () => groupConversationsByUpdatedAt(conversations),
    [conversations],
  );

  const saveTitle = async (item: ConversationSummary) => {
    const title = editingTitle.trim();
    setEditingId(undefined);
    if (!title || title === item.title) return;
    setErrorMessage("");
    try {
      await onRename(item.id, title);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "编辑会话失败");
    }
  };

  const closeSearch = () => {
    setSearchOpen(false);
    setSearchQuery("");
  };

  const enterSelectionMode = () => {
    closeSearch();
    setEditingId(undefined);
    setErrorMessage("");
    setSelectedIds(new Set());
    setSelectionMode(true);
  };

  const exitSelectionMode = () => {
    setBulkDeleteOpen(false);
    setSelectedIds(new Set());
    setSelectionMode(false);
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const beginRename = (item: ConversationSummary) => {
    setEditingId(item.id);
    setEditingTitle(item.title);
  };

  const conversationRow = (item: ConversationSummary, searchMode = false) => {
    const checked = selectedIds.has(item.id);
    const isCurrent = !selectionMode && item.id === selectedId;
    return (
      <div
        className={
          "conversation-item-row " +
          (searchMode ? "conversation-search-item-row " : "") +
          (isCurrent ? "conversation-item-row-active " : "") +
          (checked ? "conversation-item-row-selected" : "")
        }
        key={item.id}
      >
        {editingId === item.id && !selectionMode ? (
          <input
            className="conversation-title-input"
            value={editingTitle}
            maxLength={120}
            autoFocus
            aria-label="会话名称"
            onChange={(event) => setEditingTitle(event.target.value)}
            onBlur={() => void saveTitle(item)}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") setEditingId(undefined);
            }}
          />
        ) : (
          <>
            <Button
              variant="ghost"
              className={
                "conversation-item " +
                (selectionMode ? "conversation-item-selecting " : "") +
                (isCurrent ? "conversation-item-active" : "")
              }
              onClick={() =>
                selectionMode ? toggleSelected(item.id) : void onSelect(item.id)
              }
              title={item.title}
              aria-current={isCurrent ? "page" : undefined}
              aria-pressed={selectionMode ? checked : undefined}
            >
              {selectionMode && (
                <span
                  className={
                    "conversation-selection-check " +
                    (checked ? "conversation-selection-check-active" : "")
                  }
                  aria-hidden
                >
                  {checked && <Check size={13} strokeWidth={2.5} />}
                </span>
              )}
              <span className="conversation-item-copy">
                <span className="conversation-item-title">{item.title}</span>
                {searchMode && (
                  <small className="conversation-search-date">
                    {searchDateLabel(item)}
                  </small>
                )}
              </span>
            </Button>
            {!selectionMode && (
              <span className="conversation-item-actions">
                <DropdownMenuPrimitive.Root>
                  <DropdownMenuPrimitive.Trigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="conversation-more-trigger"
                      title="更多"
                      aria-label={`${item.title} 更多操作`}
                    >
                      <MoreHorizontal size={16} />
                    </Button>
                  </DropdownMenuPrimitive.Trigger>
                  <DropdownMenuPrimitive.Portal>
                    <DropdownMenuPrimitive.Content
                      className="conversation-menu"
                      sideOffset={5}
                      align="end"
                    >
                      <DropdownMenuPrimitive.Item
                        className="conversation-menu-item"
                        onSelect={() => beginRename(item)}
                      >
                        <Pencil size={14} />
                        重命名
                      </DropdownMenuPrimitive.Item>
                      <DropdownMenuPrimitive.Item
                        className="conversation-menu-item"
                        onSelect={() => {
                          void navigator.clipboard
                            ?.writeText(item.title)
                            .catch(() => undefined);
                        }}
                      >
                        <Copy size={14} />
                        复制标题
                      </DropdownMenuPrimitive.Item>
                      <DropdownMenuPrimitive.Item
                        className="conversation-menu-item conversation-menu-danger"
                        onSelect={() => setDeleteTarget(item)}
                      >
                        <Trash2 size={14} />
                        删除
                      </DropdownMenuPrimitive.Item>
                    </DropdownMenuPrimitive.Content>
                  </DropdownMenuPrimitive.Portal>
                </DropdownMenuPrimitive.Root>
              </span>
            )}
          </>
        )}
      </div>
    );
  };

  return (
    <>
      {open && (
        <Button
          className="sidebar-backdrop"
          variant="ghost"
          onClick={() => onOpenChange(false)}
          aria-label="关闭会话列表"
        />
      )}
      <aside
        className={
          "conversation-sidebar " +
          (open ? "sidebar-open " : "") +
          (collapsed ? "sidebar-collapsed" : "")
        }
      >
        <div className="sidebar-content">
          <div
            className={
              "sidebar-brand " +
              (searchOpen ? "sidebar-brand-searching " : "") +
              (selectionMode ? "sidebar-brand-selecting" : "")
            }
          >
            {selectionMode ? (
              <div className="conversation-selection-header">
                <strong>已选择 {selectedIds.size} 个对话</strong>
                <Button
                  variant="ghost"
                  size="icon"
                  className="conversation-selection-close"
                  onClick={exitSelectionMode}
                  aria-label="退出多选"
                >
                  <X size={17} />
                </Button>
              </div>
            ) : searchOpen ? (
              <div className="conversation-search">
                <Search size={15} aria-hidden />
                <input
                  value={searchQuery}
                  autoFocus
                  placeholder="搜索对话"
                  aria-label="按标题搜索对话"
                  onChange={(event) => setSearchQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") closeSearch();
                  }}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="conversation-search-close"
                  onClick={closeSearch}
                  aria-label="退出搜索"
                >
                  <X size={15} />
                </Button>
              </div>
            ) : (
              <>
                <span className="brand-mark">
                  <PiLogo size={18} />
                </span>
                <strong>Pi Chat</strong>
                <Button
                  className="sidebar-search-trigger"
                  variant="ghost"
                  size="icon"
                  onClick={() => setSearchOpen(true)}
                  aria-label="搜索会话"
                >
                  <Search size={17} />
                </Button>
                <Button
                  className="sidebar-collapse"
                  variant="ghost"
                  size="icon"
                  onClick={onCollapse}
                  aria-label="收起侧边栏"
                >
                  <PanelLeftClose size={18} />
                </Button>
                <Button
                  className="sidebar-close"
                  variant="ghost"
                  size="icon"
                  onClick={() => onOpenChange(false)}
                  aria-label="关闭会话列表"
                >
                  <X />
                </Button>
              </>
            )}
          </div>

          {!selectionMode && (
            <Button className="new-chat" onClick={() => void onNew()}>
              <Plus />
              新会话
            </Button>
          )}

          <div className="conversation-list">
            {errorMessage && (
              <p className="conversation-error" role="alert">
                {errorMessage}
              </p>
            )}

            {searchOpen ? (
              <>
                <div className="conversation-search-results-label">
                  <span>搜索结果</span>
                  {normalizedQuery && <small>{filteredConversations.length}</small>}
                </div>
                <div className="conversation-items conversation-search-results">
                  {filteredConversations.map((item) => conversationRow(item, true))}
                </div>
                {filteredConversations.length === 0 && (
                  <div className="conversation-search-empty">
                    <Search size={18} />
                    <p>{normalizedQuery ? "没有匹配的对话" : "输入标题开始搜索"}</p>
                  </div>
                )}
              </>
            ) : (
              <>
                {groups.map((group, index) => (
                  <section className="conversation-group" key={group.key}>
                    <div className="conversation-group-label">
                      <span>{group.label}</span>
                      {!selectionMode && index === 0 && conversations.length > 0 && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="conversation-multi-select-trigger"
                          onClick={enterSelectionMode}
                          title="多选"
                          aria-label="批量管理会话"
                        >
                          <ListChecks size={15} />
                        </Button>
                      )}
                    </div>
                    <div className="conversation-items">
                      {group.conversations.map((item) => conversationRow(item))}
                    </div>
                  </section>
                ))}
                {conversations.length === 0 && (
                  <p className="conversation-empty">还没有会话</p>
                )}
              </>
            )}
          </div>

          {selectionMode && (
            <div className="conversation-bulk-actions">
              <Button
                variant="ghost"
                className="conversation-bulk-delete"
                disabled={selectedIds.size === 0}
                onClick={() => setBulkDeleteOpen(true)}
              >
                <Trash2 size={16} />
                {selectedIds.size > 0 ? `删除 ${selectedIds.size} 个` : "删除"}
              </Button>
            </div>
          )}
        </div>
      </aside>

      <AlertDialogPrimitive.Root
        open={Boolean(deleteTarget)}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setDeleteTarget(undefined);
        }}
      >
        <AlertDialogPrimitive.Portal>
          <AlertDialogPrimitive.Overlay className="alert-dialog-overlay" />
          <AlertDialogPrimitive.Content className="alert-dialog-content">
            <AlertDialogPrimitive.Title className="alert-dialog-title">
              删除会话？
            </AlertDialogPrimitive.Title>
            <AlertDialogPrimitive.Description className="alert-dialog-description">
              “{deleteTarget?.title ?? ""}”及其消息记录将被永久删除。
            </AlertDialogPrimitive.Description>
            <div className="alert-dialog-actions">
              <AlertDialogPrimitive.Cancel asChild>
                <Button variant="outline">取消</Button>
              </AlertDialogPrimitive.Cancel>
              <AlertDialogPrimitive.Action asChild>
                <Button
                  className="alert-dialog-delete"
                  onClick={() => {
                    const target = deleteTarget;
                    setDeleteTarget(undefined);
                    if (!target) return;
                    setErrorMessage("");
                    void onDelete(target.id).catch((error) => {
                      setErrorMessage(
                        error instanceof Error ? error.message : "删除会话失败",
                      );
                    });
                  }}
                >
                  删除
                </Button>
              </AlertDialogPrimitive.Action>
            </div>
          </AlertDialogPrimitive.Content>
        </AlertDialogPrimitive.Portal>
      </AlertDialogPrimitive.Root>

      <AlertDialogPrimitive.Root
        open={bulkDeleteOpen}
        onOpenChange={setBulkDeleteOpen}
      >
        <AlertDialogPrimitive.Portal>
          <AlertDialogPrimitive.Overlay className="alert-dialog-overlay" />
          <AlertDialogPrimitive.Content className="alert-dialog-content">
            <AlertDialogPrimitive.Title className="alert-dialog-title">
              删除 {selectedIds.size} 个会话？
            </AlertDialogPrimitive.Title>
            <AlertDialogPrimitive.Description className="alert-dialog-description">
              所选会话及其消息记录将被永久删除。关联的 RCA 调查数据和报告会继续保留。
            </AlertDialogPrimitive.Description>
            <div className="alert-dialog-actions">
              <AlertDialogPrimitive.Cancel asChild>
                <Button variant="outline">取消</Button>
              </AlertDialogPrimitive.Cancel>
              <AlertDialogPrimitive.Action asChild>
                <Button
                  className="alert-dialog-delete"
                  onClick={() => {
                    const ids = [...selectedIds];
                    setBulkDeleteOpen(false);
                    if (ids.length === 0) return;
                    setErrorMessage("");
                    void onDeleteMany(ids)
                      .then(exitSelectionMode)
                      .catch((error) => {
                        setErrorMessage(
                          error instanceof Error ? error.message : "批量删除会话失败",
                        );
                      });
                  }}
                >
                  删除
                </Button>
              </AlertDialogPrimitive.Action>
            </div>
          </AlertDialogPrimitive.Content>
        </AlertDialogPrimitive.Portal>
      </AlertDialogPrimitive.Root>
    </>
  );
}
