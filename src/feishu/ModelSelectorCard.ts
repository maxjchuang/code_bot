import type { ChatType, SavedModelSelection } from '../domain/types.js';
import type { RenderedFeishuMessage } from './FeishuMessageRenderer.js';
import type { CodexModelInfo } from '../models/CodexModelCatalog.js';

interface ModelSelectorSnapshot {
  model?: string;
  reasoningEffort?: string;
}

export interface RenderModelSelectorCardInput {
  chatId: string;
  chatType: ChatType;
  projectId?: string;
  current?: ModelSelectorSnapshot;
  saved?: SavedModelSelection;
  clientVersion?: string;
  fetchedAt?: string;
  models: CodexModelInfo[];
  fallbackText: string;
}

export function renderModelSelectorCard(
  input: RenderModelSelectorCardInput,
): { preferred: RenderedFeishuMessage; fallback: RenderedFeishuMessage } {
  const selectedModel = selectModel(input.models, input.current?.model, input.saved?.model);
  const reasoningOptions = collectReasoningOptions(input.models);
  const selectedReasoning = selectReasoning(reasoningOptions, [
    input.current?.reasoningEffort,
    input.saved?.reasoningEffort,
    selectedModel?.defaultReasoningLevel,
  ]);

  const summaryLines = ['Choose a Codex model and reasoning level.'];
  if (input.projectId) {
    summaryLines.push(`- **Project**: \`${input.projectId}\``);
  }
  if (input.current?.model) {
    summaryLines.push(`- **Current**: \`${input.current.model}\``);
  }
  if (input.current?.reasoningEffort) {
    summaryLines.push(`- **Current reasoning**: \`${input.current.reasoningEffort}\``);
  }
  if (input.saved?.model) {
    summaryLines.push(`- **Saved default**: \`${input.saved.model}\``);
  }
  if (input.saved?.reasoningEffort) {
    summaryLines.push(`- **Saved reasoning**: \`${input.saved.reasoningEffort}\``);
  }
  if (input.clientVersion) {
    summaryLines.push(`- **Client**: \`${input.clientVersion}\``);
  }
  if (input.fetchedAt) {
    summaryLines.push(`- **Fetched**: \`${input.fetchedAt}\``);
  }

  const modelOptions = input.models.map((model) => ({
    text: {
      tag: 'plain_text',
      content: `${model.slug} (${model.displayName})`,
    },
    value: model.slug,
  }));
  const reasoningSelectOptions = reasoningOptions.map((level) => ({
    text: {
      tag: 'plain_text',
      content: level,
    },
    value: level,
  }));

  const payload = {
    schema: '2.0',
    header: {
      title: {
        tag: 'plain_text',
        content: 'Codex Model',
      },
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: summaryLines.join('\n'),
        },
        {
          tag: 'form',
          name: 'model_select_form',
          elements: [
            {
              tag: 'select_static',
              name: 'model',
              placeholder: {
                tag: 'plain_text',
                content: 'Select model',
              },
              initial_option: findOption(modelOptions, selectedModel?.slug),
              options: modelOptions,
            },
            {
              tag: 'select_static',
              name: 'reasoning',
              placeholder: {
                tag: 'plain_text',
                content: 'Select reasoning',
              },
              initial_option: findOption(reasoningSelectOptions, selectedReasoning),
              options: reasoningSelectOptions,
            },
            {
              tag: 'button',
              name: 'confirm_model_select',
              text: {
                tag: 'plain_text',
                content: 'Apply model',
              },
              type: 'primary',
              action_type: 'form_submit',
              value: {
                kind: 'model_select',
                chatId: input.chatId,
                chatType: input.chatType,
              },
            },
          ],
        },
      ],
    },
  };

  return {
    preferred: { kind: 'card', payload },
    fallback: { kind: 'text', text: input.fallbackText },
  };
}

function selectModel(models: CodexModelInfo[], currentModel?: string, savedModel?: string): CodexModelInfo | undefined {
  return (
    models.find((model) => model.slug === currentModel) ??
    models.find((model) => model.slug === savedModel) ??
    models[0]
  );
}

function collectReasoningOptions(models: CodexModelInfo[]): string[] {
  const options: string[] = [];
  for (const model of models) {
    for (const level of model.supportedReasoningLevels) {
      if (!options.includes(level)) {
        options.push(level);
      }
    }
  }
  return options;
}

function selectReasoning(options: string[], preferredValues: Array<string | undefined>): string | undefined {
  for (const value of preferredValues) {
    if (value && options.includes(value)) {
      return value;
    }
  }
  return options[0];
}

function findOption(
  options: Array<{ text: { tag: 'plain_text'; content: string }; value: string }>,
  value: string | undefined,
): { text: { tag: 'plain_text'; content: string }; value: string } | undefined {
  if (!value) {
    return undefined;
  }
  return options.find((option) => option.value === value);
}
