function interpolate(message, details = {}) {
  return Object.entries(details).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
    message,
  );
}

function attachDetails(error, key, details) {
  error.source = 'qr';
  error.key = key;
  error.details = details;
  return error;
}

export class QrError extends Error {
  constructor(key, message, details) {
    super(interpolate(message, details));
    this.name = 'QrError';
    attachDetails(this, key, details);
  }
}

export class QrRangeError extends RangeError {
  constructor(key, message, details) {
    super(interpolate(message, details));
    this.name = 'QrRangeError';
    attachDetails(this, key, details);
  }
}

export function createQrError(key, message, details, ErrorType = Error) {
  const QrErrorType = ErrorType === RangeError ? QrRangeError : QrError;
  return new QrErrorType(key, message, details);
}
