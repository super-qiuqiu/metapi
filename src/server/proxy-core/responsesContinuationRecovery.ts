import { isResponsesToolOutputOnlyInput } from '../transformers/openai/responses/continuation.js';

export type ResponsesContinuationRecoveryError = Error & {
  status: number;
  payload: {
    error: {
      type: 'invalid_request_error';
      code: 'previous_response_recovery_required';
      message: string;
      recoverable: true;
      recovery_action: 'resend_with_full_context_or_new_turn';
      recovery_hint: string;
    };
  };
  rawErrText: string;
  isResponsesContinuationRecoveryError: true;
};

export function buildResponsesContinuationRecoveryError(input: {
  reason: 'tool_output_only_without_replay_context' | 'missing_previous_response_id_on_recovery';
}): ResponsesContinuationRecoveryError {
  const recoveryHint = input.reason === 'missing_previous_response_id_on_recovery'
    ? 'Resend this turn with previous_response_id and full continuation context, or start a fresh user turn.'
    : 'This turn only contains tool outputs. Resend with prior conversation context, or start a fresh user turn.';
  const message = input.reason === 'missing_previous_response_id_on_recovery'
    ? 'Unable to safely recover continuation after previous_response_not_found.'
    : 'Tool-output-only continuation cannot be safely replayed after previous_response_not_found.';
  const payload = {
    error: {
      type: 'invalid_request_error' as const,
      code: 'previous_response_recovery_required' as const,
      message,
      recoverable: true as const,
      recovery_action: 'resend_with_full_context_or_new_turn' as const,
      recovery_hint: recoveryHint,
    },
  };
  const error = new Error(message) as ResponsesContinuationRecoveryError;
  error.name = 'ResponsesContinuationRecoveryError';
  error.status = 409;
  error.payload = payload;
  error.rawErrText = JSON.stringify(payload);
  error.isResponsesContinuationRecoveryError = true;
  return error;
}

export function isResponsesContinuationRecoveryError(error: unknown): error is ResponsesContinuationRecoveryError {
  return !!error
    && typeof error === 'object'
    && (error as ResponsesContinuationRecoveryError).isResponsesContinuationRecoveryError === true
    && typeof (error as ResponsesContinuationRecoveryError).status === 'number';
}

export function hasReplayableResponsesContinuationContext(
  body: Record<string, unknown>,
): boolean {
  if (!Array.isArray(body.input) || body.input.length <= 0) return false;
  return !isResponsesToolOutputOnlyInput(body);
}
