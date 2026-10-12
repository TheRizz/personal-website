import { isbot } from "isbot";
import { renderToReadableStream } from "react-dom/server";
import type { AppLoadContext, EntryContext } from "react-router";
import { ServerRouter } from "react-router";

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  loadContext: AppLoadContext | undefined,
) {
  let shellRendered = false;
  const userAgent = request.headers.get("user-agent");
  // The Worker's CSP nonce. Prerendering has none: `_headers` allows those pages' scripts by hash.
  const nonce = loadContext?.cspNonce;

  const body = await renderToReadableStream(
    <ServerRouter context={routerContext} url={request.url} nonce={nonce} />,
    {
      nonce,
      onError(error: unknown) {
        responseStatusCode = 500;
        // Errors before the shell renders reject the promise and are logged by React Router.
        if (shellRendered) console.error(error);
      },
    },
  );
  shellRendered = true;

  // Crawlers, prerendering and SPA mode need the complete HTML, not a stream.
  if ((userAgent && isbot(userAgent)) || routerContext.isSpaMode) {
    await body.allReady;
  }

  responseHeaders.set("Content-Type", "text/html; charset=utf-8");
  return new Response(body, { headers: responseHeaders, status: responseStatusCode });
}
