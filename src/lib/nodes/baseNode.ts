import { EncryptionOptions } from '../crypto_wrappers/cms/envelopedData';
import { SignatureOptions } from '../crypto_wrappers/cms/signedData';
import { PrivateKeyStore } from '../keyStores/privateKeyStore';
import { PublicKeyStore } from '../keyStores/publicKeyStore';

export interface NodeOptions {
  readonly encryption: Partial<EncryptionOptions>;
  readonly signature: Partial<SignatureOptions>;
}

export abstract class BaseNode {
  constructor(
    protected privateKeyStore: PrivateKeyStore,
    protected publicKeyStore: PublicKeyStore,
    protected cryptoOptions: Partial<NodeOptions> = {},
  ) {}
}