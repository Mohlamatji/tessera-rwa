/** Auth secrets. Never commit real values - put them in config/local.js or real environment variables. */
export default function buildSecurity(env = process.env) {
  return {
    admin_password_hash: env.ADMIN_PASSWORD_HASH || null, // node -e "import('./app/Support/AdminAuth.js').then(m=>console.log(m.AdminAuth.hashPassword('your-password')))"
    admin_password: env.ADMIN_PASSWORD || null,           // plain fallback (dev only)
    encryption_key: env.APP_ENCRYPTION_KEY || null,       // 32+ random chars; REQUIRED in production
    session_secret: env.SESSION_SECRET || null,           // defaults to a key derived from APP_ENCRYPTION_KEY
  };
}
