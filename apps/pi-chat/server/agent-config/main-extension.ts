import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

import {
  renderConversationRcaContext,
  type ConversationRcaContext,
} from "../rca/conversation-context";
import { agentConfigStore, renderMainConfig } from "./store";

export function createMainConfigExtension(options: {
  getAgentConfigVersion?: () => Promise<string>;
  getRcaContext?: () => ConversationRcaContext | Promise<ConversationRcaContext>;
}): ExtensionFactory {
  return async (pi) => {
    pi.on("before_agent_start", async (event) => {
      const bundle = agentConfigStore.get(await options.getAgentConfigVersion?.());
      event.systemPromptOptions.customPrompt = renderMainConfig(bundle);
      pi.setActiveTools(bundle.roles.main!.tools);
      if (options.getRcaContext)
        event.systemPromptOptions.sections.rca_context = renderConversationRcaContext(
          await options.getRcaContext(),
        );
    });
  };
}
