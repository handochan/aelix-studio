/** Native credentials never belong to Aion's provider database or WebUI login. */
export type NativeAuthCommand =
  | { action: 'catalog' }
  | { action: 'setKey'; provider: string; key: string; revision: string; exclusive: true }
  | { action: 'logout' | 'login'; provider: string; revision: string; exclusive: true }
  | {
      action: 'endpoint';
      provider: string;
      model: string;
      endpoint: string;
      api: string;
      revision: string;
      exclusive: true;
    }
  | { action: 'select'; provider: string; model: string }
  | { action: 'poll' | 'cancel'; operationId: string }
  | { action: 'reply'; operationId: string; challengeId: string; value: string };

export type NativeAuthCatalog = {
  root: string;
  authPath: string;
  modelsPath: string;
  revision: string;
  concurrentLegacyMutation: false;
  appliesAt: 'new_session';
  providers: {
    id: string;
    name: string;
    configured: boolean;
    source: string | null;
    oauth: boolean;
    models: { id: string; name: string; endpoint: string; api: string }[];
  }[];
};

export type NativeAuthOperation = {
  operationId: string;
  phase: 'pending' | 'complete' | 'failed' | 'cancelled';
  code?: string;
  authorization?: { url: string; instructions?: string };
  prompt?: {
    challengeId: string;
    message: string;
    allowEmpty: boolean;
    kind?: 'manual';
    options?: { id: string; label: string }[];
  };
};

export type NativeAuthSelection = {
  root: string;
  command: string;
  args: string[];
  env: { name: string; value: string }[];
};

export type NativeAuthData = NativeAuthCatalog | NativeAuthOperation | NativeAuthSelection;
export type NativeAuthReply = { ok: true; data: NativeAuthData } | { ok: false; code: string };
