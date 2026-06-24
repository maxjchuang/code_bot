export type CodexSessionEvent =
  | {
      type: 'user.message_submitted';
      chatId: string;
      userId: string;
      sessionId: string;
      text: string;
      at: string;
    }
  | {
      type: 'runner.started';
      sessionId: string;
      pid?: number;
      at: string;
    }
  | {
      type: 'runner.output_received';
      sessionId: string;
      text: string;
      at: string;
    }
  | {
      type: 'runner.exited';
      sessionId: string;
      exitCode?: number;
      at: string;
    }
  | {
      type: 'hook.session_started';
      sessionId: string;
      hookSessionId?: string;
      cwd?: string;
      at: string;
    }
  | {
      type: 'hook.user_prompt_submitted';
      sessionId: string;
      hookSessionId?: string;
      cwd?: string;
      at: string;
    }
  | {
      type: 'hook.stop';
      sessionId: string;
      hookSessionId?: string;
      at: string;
    }
  | {
      type: 'observation.task_completed';
      sessionId: string;
      codexSessionId: string;
      finalAnswer?: string;
      at: string;
    }
  | {
      type: 'session.recovered_interrupted';
      sessionId: string;
      at: string;
    }
  | {
      type: 'session.auto_resumed';
      sessionId: string;
      sourceSessionId: string;
      at: string;
    };
