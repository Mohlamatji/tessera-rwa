/** Who is calling. `type`: 'wallet' (investor session), 'admin_session', or 'open' (dev, unauthenticated). */
export class AuthContext {
  constructor(type, id, label, { wallet = null, scopes = [] } = {}) {
    this.type = type; this.id = id; this.label = label; this.wallet = wallet; this.scopes = scopes;
  }
  can(scope) { return this.scopes.includes('*') || this.scopes.includes(scope); }
}
