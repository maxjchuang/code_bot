import type { BotConfig, ChatType, ProjectConfig } from '../domain/types.js';

export interface IncomingPrincipal {
  userId: string;
  chatId: string;
  chatType: ChatType;
}

export function isAuthorizedMessage(config: BotConfig, principal: IncomingPrincipal): boolean {
  if (!config.allowedUsers.includes(principal.userId)) {
    return false;
  }
  if (principal.chatType === 'private') {
    return true;
  }
  return config.allowedChatIds.includes(principal.chatId);
}

export function resolveProject(config: BotConfig, projectId: string): ProjectConfig | undefined {
  return config.projects.find((project) => project.id === projectId);
}
