import providers from '../../../config/providers.js';
import { MockAdapter } from './MockAdapter.js';
import { assertAdapter } from './VerificationAdapterInterface.js';

const REGISTRY = {
  mock: () => new MockAdapter(),
  // vendorX: () => new VendorXAdapter({ baseUrl: process.env.VENDORX_URL, apiKey: process.env.VENDORX_KEY }),
};

export const AdapterFactory = {
  create(name = providers.provider) {
    const make = REGISTRY[name];
    if (!make) throw new Error(`Unknown VERIFICATION_PROVIDER "${name}". Register it in AdapterFactory.js.`);
    return assertAdapter(make());
  },
};
