// Generates a fresh attestor key. It signs KYC claims only and must hold NO funds.
import { ethers } from 'ethers';
const w = ethers.Wallet.createRandom();
console.log('ATTESTOR_PRIVATE_KEY=' + w.privateKey);
console.log('# attestor address (pass to deploy as ATTESTOR_ADDRESS, or let deploy derive it): ' + w.address);
