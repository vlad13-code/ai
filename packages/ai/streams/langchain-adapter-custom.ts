import { mergeStreams } from '../core/util/merge-streams';
import { prepareResponseHeaders } from '../core/util/prepare-response-headers';
import {
  AIStreamCallbacksAndOptions,
  createCallbacksTransformer,
} from './ai-stream';
import { StreamData } from './stream-data';
import { formatStreamPart } from '../../ui-utils/src/stream-parts';

type LangChainImageDetail = 'auto' | 'low' | 'high';

type LangChainMessageContentText = {
  type: 'text';
  text: string;
};

type LangChainMessageContentImageUrl = {
  type: 'image_url';
  image_url:
    | string
    | {
        url: string;
        detail?: LangChainImageDetail;
      };
};

type LangChainMessageContentComplex =
  | LangChainMessageContentText
  | LangChainMessageContentImageUrl
  | (Record<string, any> & {
      type?: 'text' | 'image_url' | string;
    })
  | (Record<string, any> & {
      type?: never;
    });

type LangChainMessageContent = string | LangChainMessageContentComplex[];

type LangChainAIMessageChunk = {
  content: LangChainMessageContent;
};

// LC stream event v2
type LangChainStreamEvent = {
  event: string;
  data: any;
  name?: string;
  run_id?: string;
};

/**
Converts LangChain output streams to AIStream.

The following streams are supported:
- `LangChainAIMessageChunk` streams (LangChain `model.stream` output)
- `string` streams (LangChain `StringOutputParser` output)

@deprecated Use `toDataStream` instead.
 */
export function toAIStream(
  stream:
    | ReadableStream<LangChainStreamEvent>
    | ReadableStream<LangChainAIMessageChunk>
    | ReadableStream<string>,
  callbacks?: AIStreamCallbacksAndOptions,
) {
  return toDataStream(stream, callbacks);
}

/**
Converts LangChain output streams to AIStream.

The following streams are supported:
- `LangChainAIMessageChunk` streams (LangChain `model.stream` output)
- `string` streams (LangChain `StringOutputParser` output)
 */
export function toDataStream(
  stream:
    | ReadableStream<LangChainStreamEvent>
    | ReadableStream<LangChainAIMessageChunk>
    | ReadableStream<string>,
  callbacks?: AIStreamCallbacksAndOptions,
) {
  return stream
    .pipeThrough(
      new TransformStream<
        LangChainStreamEvent | LangChainAIMessageChunk | string
      >({
        transform: async (value, controller) => {
          // text stream:
          if (typeof value === 'string') {
            controller.enqueue(value);
            return;
          }

          // LC stream events v2:
          if ('event' in value) {
            // chunk is AIMessage Chunk for on_chat_model_stream event:
            if (value.event === 'on_chat_model_stream') {
              forwardAIMessageChunk(
                value.data?.chunk as LangChainAIMessageChunk,
                controller,
              );
            } else if (value.event === 'on_tool_start') {
              forwardToolCall(value, controller);
            } else if (value.event === 'on_tool_end') {
              forwardToolCallResult(value, controller);
            }
            return;
          }

          // AI Message chunk stream:
          forwardAIMessageChunk(value, controller);
        },
      }),
    )
    .pipeThrough(createCallbacksTransformer(callbacks));
}

export function toDataStreamResponse(
  stream:
    | ReadableStream<LangChainStreamEvent>
    | ReadableStream<LangChainAIMessageChunk>
    | ReadableStream<string>,
  options?: {
    init?: ResponseInit;
    data?: StreamData;
    callbacks?: AIStreamCallbacksAndOptions;
  },
) {
  const dataStream = toDataStream(stream, options?.callbacks);
  const data = options?.data;
  const init = options?.init;

  const responseStream = data
    ? mergeStreams(data.stream, dataStream)
    : dataStream;

  return new Response(responseStream, {
    status: init?.status ?? 200,
    statusText: init?.statusText,
    headers: prepareResponseHeaders(init, {
      contentType: 'text/plain; charset=utf-8',
      dataStreamVersion: 'v1',
    }),
  });
}

function forwardToolCall(
  event: LangChainStreamEvent,
  controller: TransformStreamDefaultController<any>,
) {
  controller.enqueue(
    formatStreamPart('tool_call', {
      toolCallId: event.run_id!,
      toolName: event.name!,
      args: event.data?.input,
    }),
  );
}

function forwardToolCallResult(
  event: LangChainStreamEvent,
  controller: TransformStreamDefaultController<any>,
) {
  controller.enqueue(
    formatStreamPart('tool_result', {
      toolCallId: event.run_id!,
      result: event.data?.output.content,
    }),
  );
}

function forwardAIMessageChunk(
  chunk: LangChainAIMessageChunk,
  controller: TransformStreamDefaultController<any>,
) {
  if (typeof chunk.content === 'string') {
    controller.enqueue(formatStreamPart('text', chunk.content));
  } else {
    const content: LangChainMessageContentComplex[] = chunk.content;
    for (const item of content) {
      if (item.type === 'text') {
        controller.enqueue(formatStreamPart('text', item.text));
      }
    }
  }
}
