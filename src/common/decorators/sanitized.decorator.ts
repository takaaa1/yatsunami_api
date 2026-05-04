import { Transform } from 'class-transformer';
import {
  sanitizeUserInput,
  type UserInputSanitizeKind,
} from '../utils/sanitize-user-input';

/**
 * Aplica sanitização na transformação do DTO (antes da validação class-validator).
 */
export function Sanitized(kind: UserInputSanitizeKind = 'plain', maxLength?: number) {
  return Transform(({ value }) => {
    if (value === undefined || value === null) {
      return value;
    }
    if (typeof value !== 'string') {
      return value;
    }
    return sanitizeUserInput(value, { kind, maxLength });
  });
}
