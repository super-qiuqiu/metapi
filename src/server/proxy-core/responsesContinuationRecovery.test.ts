import { describe, expect, it } from 'vitest';

import {
  buildResponsesContinuationRecoveryError,
  hasReplayableResponsesContinuationContext,
  isResponsesContinuationRecoveryError,
} from './responsesContinuationRecovery.js';

describe('responses continuation recovery helpers', () => {
  it('builds a recoverable continuation error payload', () => {
    const error = buildResponsesContinuationRecoveryError({
      reason: 'tool_output_only_without_replay_context',
    });
    expect(isResponsesContinuationRecoveryError(error)).toBe(true);
    expect(error.status).toBe(409);
    expect(error.payload.error).toMatchObject({
      code: 'previous_response_recovery_required',
      recoverable: true,
    });
  });

  it('detects replayable context only when non-tool-output inputs exist', () => {
    expect(hasReplayableResponsesContinuationContext({
      input: [{
        type: 'function_call_output',
        call_id: 'call_1',
        output: '{"ok":true}',
      }],
    })).toBe(false);

    expect(hasReplayableResponsesContinuationContext({
      input: [
        {
          type: 'function_call_output',
          call_id: 'call_1',
          output: '{"ok":true}',
        },
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'continue' }],
        },
      ],
    })).toBe(true);
  });
});
