// Launcher (the equivalent of identity-vault's root index.php): `node index.js` or `npm start`.
// The real front controller lives in public/index.js so tests and the demo can start it in-process.
import { startServer } from './public/index.js';

const { server, config } = await startServer();
console.log(`Tessera listening on http://localhost:${config.port}  (${config.env}${config.demo_mode ? ', demo mode' : ''}${config.chain.enabled ? ', on-chain: ' + config.chain.name : ', on-chain: off'})`);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
