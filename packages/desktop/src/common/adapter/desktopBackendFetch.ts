type BackendFetcher = (url: string, init?: RequestInit) => Promise<Response>;

let desktopFetcher: BackendFetcher | undefined;

/** Register the privileged transport in Electron's main process. */
export function registerDesktopBackendFetcher(fetcher: BackendFetcher): void {
  desktopFetcher = fetcher;
}

export function fetchFromDesktopOrBrowser(url: string, init: RequestInit): Promise<Response> {
  return (desktopFetcher ?? fetch)(url, init);
}
