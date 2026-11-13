import { type SseListener } from './sse-types';
import { withUserAgent } from '../util/http';
import { kotlinListener } from './kotlin-listener.ios';
import { traceAssistantStage } from './assistant-trace';
export { type SseListener } from './sse-types';
declare const FaceclawKitIosSseRequest: any, FaceclawKitFaceclawSseListener: any;

/** The shared Kotlin SseStream over NSURLSession; the Kotlin side delivers every callback on the main queue, in order. */
export function openSseRequest(url: string, body: string, headers: Record<string, string>, listener: SseListener): { cancel(): void } {
  let ended = false;
  let firstLine = true;
  const traced = Boolean(headers['X-OpenClaw-Input-Connection']);
  if (traced) traceAssistantStage('sse.started');
  const once = (deliver: () => void) => { if (ended) return; ended = true; deliver(); };
  const nativeListener = kotlinListener(FaceclawKitFaceclawSseListener, {
    onLineLine: (line: string) => {
      if (traced && firstLine) { firstLine = false; traceAssistantStage('sse.first-line', String(line ?? '').length); }
      if (!ended) listener.onLine(String(line ?? ''));
    },
    onHttpErrorCodeBody: (code: number, errorBody: string) => once(() => {
      if (traced) traceAssistantStage('sse.http-error', Number(code));
      listener.onHttpError(Number(code), String(errorBody ?? ''));
    }),
    onComplete: () => once(() => { if (traced) traceAssistantStage('sse.completed'); listener.onComplete(); }),
    onFailureMessage_: (message: string) => once(() => { if (traced) traceAssistantStage('sse.failed'); listener.onFailure(String(message ?? '')); }),
  });
  const native = FaceclawKitIosSseRequest.alloc().initWithUrlBodyHeadersJsonListener(url, body, JSON.stringify(withUserAgent(headers)), nativeListener);
  return { cancel: () => { if (ended) return; ended = true; if (traced) traceAssistantStage('sse.cancelled'); native.cancel(); } };
}
