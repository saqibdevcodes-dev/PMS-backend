export type Actor = {
  id: string;
  sessionId: string;
  permissions: Set<string>;
  accountType?: 'STAFF' | 'CUSTOMER';
};
export type Context = { actor: Actor; projectId: string; requestId: string };
