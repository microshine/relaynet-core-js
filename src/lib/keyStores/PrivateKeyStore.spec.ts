import { HashingAlgorithm, RSAModulus } from '../crypto_wrappers/algorithms';
import {
  derSerializePrivateKey,
  derSerializePublicKey,
  getPrivateAddressFromIdentityKey,
} from '../crypto_wrappers/keys';
import { SessionKeyPair } from '../SessionKeyPair';
import { KeyStoreError } from './KeyStoreError';
import { SessionPrivateKeyData } from './PrivateKeyStore';
import { MockPrivateKeyStore } from './testMocks';
import UnknownKeyError from './UnknownKeyError';

const MOCK_STORE = new MockPrivateKeyStore();
beforeEach(() => {
  MOCK_STORE.clear();
});

describe('Identity keys', () => {
  describe('generateIdentityKeyPair', () => {
    test('RSA modulus 2048 should be generated by default', async () => {
      const keyPair = await MOCK_STORE.generateIdentityKeyPair();

      expect(keyPair.privateKey.algorithm).toHaveProperty('modulusLength', 2048);
    });

    test.each([2048, 3072, 4096] as readonly RSAModulus[])(
      'RSA modulus %s should be used if requested',
      async (modulus) => {
        const keyPair = await MOCK_STORE.generateIdentityKeyPair({ modulus });

        expect(keyPair.privateKey.algorithm).toHaveProperty('modulusLength', modulus);
      },
    );

    test('SHA-256 should be used by default', async () => {
      const keyPair = await MOCK_STORE.generateIdentityKeyPair();

      expect(keyPair.privateKey.algorithm).toHaveProperty('hash.name', 'SHA-256');
    });

    test.each(['SHA-256', 'SHA-384', 'SHA-512'] as readonly HashingAlgorithm[])(
      'Hashing algorithm %s should be used if requested',
      async (hashingAlgorithm) => {
        const keyPair = await MOCK_STORE.generateIdentityKeyPair({ hashingAlgorithm });

        expect(keyPair.privateKey.algorithm).toHaveProperty('hash.name', hashingAlgorithm);
      },
    );

    test('Private address should be returned', async () => {
      const keyPair = await MOCK_STORE.generateIdentityKeyPair();

      expect(keyPair.privateAddress).toEqual(
        await getPrivateAddressFromIdentityKey(keyPair.publicKey),
      );
    });

    test('Public key should correspond to private key', async () => {
      const keyPair = await MOCK_STORE.generateIdentityKeyPair();

      const expectedPublicKeySerialized = await derSerializePublicKey(keyPair.privateKey);
      await expect(derSerializePublicKey(keyPair.publicKey)).resolves.toEqual(
        expectedPublicKeySerialized,
      );
    });

    test('Key should be stored', async () => {
      const { privateAddress, privateKey } = await MOCK_STORE.generateIdentityKeyPair();

      expect(MOCK_STORE.identityKeys).toHaveProperty(privateAddress, privateKey);
    });

    test('Errors should be wrapped', async () => {
      const store = new MockPrivateKeyStore(true);

      await expect(store.generateIdentityKeyPair()).rejects.toThrowWithMessage(
        KeyStoreError,
        /^Failed to save key for \w+: Denied/,
      );
    });
  });
});

describe('Session keys', () => {
  let sessionKeyPair: SessionKeyPair;
  let sessionKeyIdHex: string;
  beforeAll(async () => {
    sessionKeyPair = await SessionKeyPair.generate();
    sessionKeyIdHex = sessionKeyPair.sessionKey.keyId.toString('hex');
  });

  const PRIVATE_ADDRESS = '0deadc0de';
  const PEER_PRIVATE_ADDRESS = '0deadbeef';

  describe('saveSessionKey', () => {
    test('Unbound key should be stored', async () => {
      await MOCK_STORE.saveSessionKey(
        sessionKeyPair.privateKey,
        sessionKeyPair.sessionKey.keyId,
        PRIVATE_ADDRESS,
      );

      expect(MOCK_STORE.sessionKeys).toHaveProperty<SessionPrivateKeyData>(sessionKeyIdHex, {
        keySerialized: await derSerializePrivateKey(sessionKeyPair.privateKey),
        privateAddress: PRIVATE_ADDRESS,
      });
    });

    test('Bound key should be stored', async () => {
      await MOCK_STORE.saveSessionKey(
        sessionKeyPair.privateKey,
        sessionKeyPair.sessionKey.keyId,
        PRIVATE_ADDRESS,
        PEER_PRIVATE_ADDRESS,
      );

      expect(MOCK_STORE.sessionKeys).toHaveProperty<SessionPrivateKeyData>(sessionKeyIdHex, {
        keySerialized: await derSerializePrivateKey(sessionKeyPair.privateKey),
        peerPrivateAddress: PEER_PRIVATE_ADDRESS,
        privateAddress: PRIVATE_ADDRESS,
      });
    });

    test('Errors should be wrapped', async () => {
      const store = new MockPrivateKeyStore(true);

      await expect(
        store.saveSessionKey(
          sessionKeyPair.privateKey,
          sessionKeyPair.sessionKey.keyId,
          PRIVATE_ADDRESS,
        ),
      ).rejects.toThrowWithMessage(KeyStoreError, `Failed to save key ${sessionKeyIdHex}: Denied`);
    });
  });

  describe('retrieveUnboundSessionKey', () => {
    test('Existing key should be returned', async () => {
      await MOCK_STORE.saveSessionKey(
        sessionKeyPair.privateKey,
        sessionKeyPair.sessionKey.keyId,
        PRIVATE_ADDRESS,
      );

      const keySerialized = await MOCK_STORE.retrieveUnboundSessionKey(
        sessionKeyPair.sessionKey.keyId,
        PRIVATE_ADDRESS,
      );

      expect(await derSerializePrivateKey(keySerialized)).toEqual(
        await derSerializePrivateKey(sessionKeyPair.privateKey),
      );
    });

    test('UnknownKeyError should be thrown if key id does not exist', async () => {
      await expect(
        MOCK_STORE.retrieveUnboundSessionKey(sessionKeyPair.sessionKey.keyId, PRIVATE_ADDRESS),
      ).rejects.toThrowWithMessage(UnknownKeyError, `Key ${sessionKeyIdHex} does not exist`);
    });

    test('Key should not be returned if owned by different node', async () => {
      await MOCK_STORE.saveSessionKey(
        sessionKeyPair.privateKey,
        sessionKeyPair.sessionKey.keyId,
        PRIVATE_ADDRESS,
      );

      await expect(
        MOCK_STORE.retrieveUnboundSessionKey(
          sessionKeyPair.sessionKey.keyId,
          `not-${PRIVATE_ADDRESS}`,
        ),
      ).rejects.toThrowWithMessage(UnknownKeyError, 'Key is owned by a different node');
    });

    test('Subsequent session keys should not be returned', async () => {
      await MOCK_STORE.saveSessionKey(
        sessionKeyPair.privateKey,
        sessionKeyPair.sessionKey.keyId,
        PRIVATE_ADDRESS,
        PEER_PRIVATE_ADDRESS,
      );

      await expect(
        MOCK_STORE.retrieveUnboundSessionKey(sessionKeyPair.sessionKey.keyId, PRIVATE_ADDRESS),
      ).rejects.toThrowWithMessage(UnknownKeyError, `Key ${sessionKeyIdHex} is bound`);
    });

    test('Errors should be wrapped', async () => {
      const store = new MockPrivateKeyStore(false, true);

      await expect(
        store.retrieveUnboundSessionKey(sessionKeyPair.sessionKey.keyId, PRIVATE_ADDRESS),
      ).rejects.toEqual(new KeyStoreError('Failed to retrieve key: Denied'));
    });
  });

  describe('retrieveSessionKey', () => {
    test('Initial session keys should be returned', async () => {
      await MOCK_STORE.saveSessionKey(
        sessionKeyPair.privateKey,
        sessionKeyPair.sessionKey.keyId,
        PRIVATE_ADDRESS,
      );

      const privateKey = await MOCK_STORE.retrieveSessionKey(
        sessionKeyPair.sessionKey.keyId,
        PRIVATE_ADDRESS,
        PEER_PRIVATE_ADDRESS,
      );

      expect(await derSerializePrivateKey(privateKey)).toEqual(
        await derSerializePrivateKey(privateKey),
      );
    });

    test('Bound session keys should be returned', async () => {
      await MOCK_STORE.saveSessionKey(
        sessionKeyPair.privateKey,
        sessionKeyPair.sessionKey.keyId,
        PRIVATE_ADDRESS,
        PEER_PRIVATE_ADDRESS,
      );

      const privateKey = await MOCK_STORE.retrieveSessionKey(
        sessionKeyPair.sessionKey.keyId,
        PRIVATE_ADDRESS,
        PEER_PRIVATE_ADDRESS,
      );

      expect(await derSerializePrivateKey(privateKey)).toEqual(
        await derSerializePrivateKey(privateKey),
      );
    });

    test('UnknownKeyError should be thrown if key pair does not exist', async () => {
      await expect(
        MOCK_STORE.retrieveSessionKey(
          sessionKeyPair.sessionKey.keyId,
          PRIVATE_ADDRESS,
          PEER_PRIVATE_ADDRESS,
        ),
      ).rejects.toThrowWithMessage(UnknownKeyError, `Key ${sessionKeyIdHex} does not exist`);
    });

    test('Key should not be returned if owned by different node', async () => {
      await MOCK_STORE.saveSessionKey(
        sessionKeyPair.privateKey,
        sessionKeyPair.sessionKey.keyId,
        PRIVATE_ADDRESS,
        PEER_PRIVATE_ADDRESS,
      );

      await expect(
        MOCK_STORE.retrieveSessionKey(
          sessionKeyPair.sessionKey.keyId,
          `not-${PRIVATE_ADDRESS}`,
          PEER_PRIVATE_ADDRESS,
        ),
      ).rejects.toThrowWithMessage(UnknownKeyError, 'Key is owned by a different node');
    });

    test('Keys bound to another recipient should not be returned', async () => {
      await MOCK_STORE.saveSessionKey(
        sessionKeyPair.privateKey,
        sessionKeyPair.sessionKey.keyId,
        PRIVATE_ADDRESS,
        PEER_PRIVATE_ADDRESS,
      );

      const invalidPeerPrivateAddress = `not ${PEER_PRIVATE_ADDRESS}`;
      await expect(
        MOCK_STORE.retrieveSessionKey(
          sessionKeyPair.sessionKey.keyId,
          PRIVATE_ADDRESS,
          invalidPeerPrivateAddress,
        ),
      ).rejects.toThrowWithMessage(
        UnknownKeyError,
        `Session key ${sessionKeyIdHex} is bound to another recipient ` +
          `(${PEER_PRIVATE_ADDRESS}, not ${invalidPeerPrivateAddress})`,
      );
    });

    test('Errors should be wrapped', async () => {
      const store = new MockPrivateKeyStore(false, true);

      await expect(
        store.retrieveSessionKey(
          sessionKeyPair.sessionKey.keyId,
          PRIVATE_ADDRESS,
          PEER_PRIVATE_ADDRESS,
        ),
      ).rejects.toEqual(new KeyStoreError('Failed to retrieve key: Denied'));
    });
  });
});
