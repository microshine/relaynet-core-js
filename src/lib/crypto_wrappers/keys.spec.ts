import bufferToArray from 'buffer-to-arraybuffer';
import { createHash } from 'crypto';
import { CryptoEngine } from 'pkijs';

import { arrayBufferFrom, sha256Hex } from '../_test_utils';
import { ECDHCurveName, HashingAlgorithm, RSAModulus } from './algorithms';
import {
  derDeserializeECDHPrivateKey,
  derDeserializeECDHPublicKey,
  derDeserializeRSAPrivateKey,
  derDeserializeRSAPublicKey,
  derSerializePrivateKey,
  derSerializePublicKey,
  generateECDHKeyPair,
  generateRSAKeyPair,
  getPrivateAddressFromIdentityKey,
  getPublicKeyDigest,
  getPublicKeyDigestHex,
  getRSAPublicKeyFromPrivate,
} from './keys';

describe('generateRsaKeyPair', () => {
  test('Keys should be RSA-PSS', async () => {
    const keyPair = await generateRSAKeyPair();

    expect(keyPair.publicKey.algorithm.name).toEqual('RSA-PSS');
    expect(keyPair.privateKey.algorithm.name).toEqual('RSA-PSS');
  });

  test('Keys should be extractable', async () => {
    const keyPair = await generateRSAKeyPair();

    expect(keyPair.publicKey.extractable).toEqual(true);
    expect(keyPair.privateKey.extractable).toEqual(true);
  });

  test('Key usages should be used for signatures only', async () => {
    const keyPair = await generateRSAKeyPair();

    expect(keyPair).toHaveProperty('publicKey.usages', ['verify']);
    expect(keyPair).toHaveProperty('privateKey.usages', ['sign']);
  });

  describe('Modulus', () => {
    test('Default modulus should be 2048', async () => {
      const keyPair = await generateRSAKeyPair();
      expect(keyPair.publicKey.algorithm).toHaveProperty('modulusLength', 2048);
      expect(keyPair.privateKey.algorithm).toHaveProperty('modulusLength', 2048);
    });

    test.each([2048, 3072, 4096] as readonly RSAModulus[])(
      'Modulus %s should be used if explicitly requested',
      async () => {
        const modulus = 4096;
        const keyPair = await generateRSAKeyPair({ modulus });
        expect(keyPair.publicKey.algorithm).toHaveProperty('modulusLength', modulus);
        expect(keyPair.privateKey.algorithm).toHaveProperty('modulusLength', modulus);
      },
    );

    test('Modulus < 2048 should not supported', async () => {
      await expect(generateRSAKeyPair({ modulus: 1024 } as any)).rejects.toThrow(
        'RSA modulus must be => 2048 per RS-018 (got 1024)',
      );
    });
  });

  describe('Hashing algorithm', () => {
    test('SHA-256 should be used by default', async () => {
      const keyPair = await generateRSAKeyPair();
      expect(keyPair.publicKey.algorithm).toHaveProperty('hash.name', 'SHA-256');
      expect(keyPair.privateKey.algorithm).toHaveProperty('hash.name', 'SHA-256');
    });

    test.each(['SHA-384', 'SHA-512'] as readonly HashingAlgorithm[])(
      '%s hashing should be supported',
      async (hashingAlgorithm) => {
        const keyPair = await generateRSAKeyPair({ hashingAlgorithm });
        expect(keyPair.publicKey.algorithm).toHaveProperty('hash.name', hashingAlgorithm);
        expect(keyPair.privateKey.algorithm).toHaveProperty('hash.name', hashingAlgorithm);
      },
    );

    test('SHA-1 should not be supported', async () => {
      await expect(generateRSAKeyPair({ hashingAlgorithm: 'SHA-1' } as any)).rejects.toThrow(
        'SHA-1 is disallowed by RS-018',
      );
    });
  });
});

describe('generateDHKeyPair', () => {
  test('The result should be a DH key pair', async () => {
    const keyPair = await generateECDHKeyPair();

    expect(keyPair).toHaveProperty('privateKey.algorithm.name', 'ECDH');
    expect(keyPair).toHaveProperty('publicKey.algorithm.name', 'ECDH');
  });

  test('NIST P-256 curve should be used by default', async () => {
    const keyPair = await generateECDHKeyPair();

    expect(keyPair).toHaveProperty('privateKey.algorithm.namedCurve', 'P-256');
    expect(keyPair).toHaveProperty('publicKey.algorithm.namedCurve', 'P-256');
  });

  test.each([['P-384', 'P-521']])('%s should also be supported', async (curveName) => {
    const keyPair = await generateECDHKeyPair(curveName as ECDHCurveName);

    expect(keyPair).toHaveProperty('privateKey.algorithm.namedCurve', curveName);
    expect(keyPair).toHaveProperty('publicKey.algorithm.namedCurve', curveName);
  });

  test('The key pair should be extractable', async () => {
    const keyPair = await generateECDHKeyPair();

    expect(keyPair).toHaveProperty('privateKey.extractable', true);
    expect(keyPair).toHaveProperty('publicKey.extractable', true);
  });

  test('deriveKey and deriveBits should be the only uses of the private keys', async () => {
    const keyPair = await generateECDHKeyPair();

    expect(keyPair.privateKey.usages).toContainValues(['deriveBits', 'deriveKey']);
    expect(keyPair.publicKey.usages).toBeEmpty();
  });
});

describe('getRSAPublicKeyFromPrivate', () => {
  test('Public key should be returned', async () => {
    const keyPair = await generateRSAKeyPair();

    const publicKey = await getRSAPublicKeyFromPrivate(keyPair.privateKey);

    // It's important to check we got a public key before checking its serialisation. If we try to
    // serialise a private key with SPKI, it'd internally use the public key first.
    expect(publicKey.type).toEqual(keyPair.publicKey.type);
    await expect(derSerializePublicKey(publicKey)).resolves.toEqual(
      await derSerializePublicKey(keyPair.publicKey),
    );
  });

  test('Public key should honour algorithm parameters', async () => {
    const keyPair = await generateRSAKeyPair();

    const publicKey = await getRSAPublicKeyFromPrivate(keyPair.privateKey);

    expect(publicKey.algorithm).toEqual(keyPair.publicKey.algorithm);
  });

  test('Public key should only be used to verify signatures', async () => {
    const keyPair = await generateRSAKeyPair();

    const publicKey = await getRSAPublicKeyFromPrivate(keyPair.privateKey);

    expect(publicKey.usages).toEqual(['verify']);
  });
});

describe('Key serializers', () => {
  let stubKeyPair: CryptoKeyPair;
  beforeAll(async () => {
    stubKeyPair = await generateRSAKeyPair();
  });

  const stubExportedKeyDer = arrayBufferFrom('Hey');
  const mockExportKey = jest.spyOn(CryptoEngine.prototype, 'exportKey');
  beforeEach(async () => {
    mockExportKey.mockReset();
    mockExportKey.mockResolvedValue(stubExportedKeyDer);
  });

  afterAll(() => {
    mockExportKey.mockRestore();
  });

  test('derSerializePublicKey should convert public key to buffer', async () => {
    const publicKeyDer = await derSerializePublicKey(stubKeyPair.publicKey);

    expect(publicKeyDer).toEqual(Buffer.from(stubExportedKeyDer));

    expect(mockExportKey).toBeCalledTimes(1);
    expect(mockExportKey).toBeCalledWith('spki', stubKeyPair.publicKey);
  });

  test('derSerializePrivateKey should convert private key to buffer', async () => {
    const privateKeyDer = await derSerializePrivateKey(stubKeyPair.privateKey);

    expect(privateKeyDer).toEqual(Buffer.from(stubExportedKeyDer));

    expect(mockExportKey).toBeCalledTimes(1);
    expect(mockExportKey).toBeCalledWith('pkcs8', stubKeyPair.privateKey);
  });
});

describe('Key deserializers', () => {
  const stubKeyDer = Buffer.from('Hey');
  const rsaAlgorithmOptions: RsaHashedImportParams = { name: 'RSA-PSS', hash: { name: 'SHA-256' } };
  const ecdhCurveName: NamedCurve = 'P-384';

  let stubKeyPair: CryptoKeyPair;
  beforeAll(async () => {
    stubKeyPair = await generateRSAKeyPair();
  });
  const mockImportKey = jest.spyOn(CryptoEngine.prototype, 'importKey');
  beforeEach(async () => {
    mockImportKey.mockClear();
  });

  afterAll(() => {
    mockImportKey.mockRestore();
  });

  test('derDeserializeRSAPublicKey should convert DER public key to RSA key', async () => {
    mockImportKey.mockResolvedValueOnce(stubKeyPair.publicKey);

    const publicKey = await derDeserializeRSAPublicKey(stubKeyDer, rsaAlgorithmOptions);

    expect(publicKey).toBe(stubKeyPair.publicKey);
    expect(mockImportKey).toBeCalledTimes(1);
    expect(mockImportKey).toBeCalledWith(
      'spki',
      bufferToArray(stubKeyDer),
      rsaAlgorithmOptions,
      true,
      ['verify'],
    );
  });

  test('derDeserializeRSAPublicKey should default to RSA-PSS with SHA-256', async () => {
    mockImportKey.mockResolvedValueOnce(stubKeyPair.publicKey);

    const publicKey = await derDeserializeRSAPublicKey(stubKeyDer);

    expect(publicKey).toBe(stubKeyPair.publicKey);
    expect(mockImportKey).toBeCalledTimes(1);
    expect(mockImportKey).toBeCalledWith(
      'spki',
      bufferToArray(stubKeyDer),
      rsaAlgorithmOptions,
      true,
      ['verify'],
    );
  });

  test('derDeserializeRSAPublicKey should accept an ArrayBuffer serialization', async () => {
    mockImportKey.mockResolvedValueOnce(stubKeyPair.publicKey);

    const keyDerArrayBuffer = arrayBufferFrom(stubKeyDer);
    const publicKey = await derDeserializeRSAPublicKey(keyDerArrayBuffer, rsaAlgorithmOptions);

    expect(publicKey).toBe(stubKeyPair.publicKey);
    expect(mockImportKey).toBeCalledTimes(1);
    expect(mockImportKey).toBeCalledWith('spki', keyDerArrayBuffer, rsaAlgorithmOptions, true, [
      'verify',
    ]);
  });

  test('derDeserializeRSAPrivateKey should convert DER private key to RSA key', async () => {
    mockImportKey.mockResolvedValueOnce(stubKeyPair.privateKey);

    const privateKey = await derDeserializeRSAPrivateKey(stubKeyDer, rsaAlgorithmOptions);

    expect(privateKey).toBe(stubKeyPair.privateKey);
    expect(mockImportKey).toBeCalledTimes(1);
    expect(mockImportKey).toBeCalledWith(
      'pkcs8',
      bufferToArray(stubKeyDer),
      rsaAlgorithmOptions,
      true,
      ['sign'],
    );
  });

  test('derDeserializeRSAPrivateKey should default to RSA-PSS with SHA-256', async () => {
    mockImportKey.mockResolvedValueOnce(stubKeyPair.privateKey);

    const privateKey = await derDeserializeRSAPrivateKey(stubKeyDer);

    expect(privateKey).toBe(stubKeyPair.privateKey);
    expect(mockImportKey).toBeCalledTimes(1);
    expect(mockImportKey).toBeCalledWith(
      'pkcs8',
      bufferToArray(stubKeyDer),
      rsaAlgorithmOptions,
      true,
      ['sign'],
    );
  });

  test('derDeserializeECDHPublicKey should convert DER public key to ECDH key', async () => {
    mockImportKey.mockResolvedValueOnce(stubKeyPair.publicKey);

    const publicKey = await derDeserializeECDHPublicKey(stubKeyDer, ecdhCurveName);

    expect(publicKey).toBe(stubKeyPair.publicKey);
    expect(mockImportKey).toBeCalledTimes(1);
    expect(mockImportKey).toBeCalledWith(
      'spki',
      bufferToArray(stubKeyDer),
      { name: 'ECDH', namedCurve: ecdhCurveName },
      true,
      [],
    );
  });

  test('derDeserializeECDHPublicKey should default to P-256', async () => {
    mockImportKey.mockResolvedValueOnce(stubKeyPair.publicKey);

    await derDeserializeECDHPublicKey(stubKeyDer);

    expect(mockImportKey).toBeCalledTimes(1);
    const algorithm = mockImportKey.mock.calls[0][2];
    expect(algorithm).toHaveProperty('namedCurve', 'P-256');
  });

  test('derDeserializeECDHPublicKey should accept an ArrayBuffer serialization', async () => {
    mockImportKey.mockResolvedValueOnce(stubKeyPair.publicKey);

    const publicKeyDerArrayBuffer = bufferToArray(stubKeyDer);
    const publicKey = await derDeserializeECDHPublicKey(publicKeyDerArrayBuffer, ecdhCurveName);

    expect(publicKey).toBe(stubKeyPair.publicKey);
    expect(mockImportKey).toBeCalledTimes(1);
    expect(mockImportKey).toBeCalledWith(
      'spki',
      publicKeyDerArrayBuffer,
      { name: 'ECDH', namedCurve: ecdhCurveName },
      true,
      [],
    );
  });

  test('derDeserializeECDHPrivateKey should convert DER private key to ECDH key', async () => {
    mockImportKey.mockResolvedValueOnce(stubKeyPair.privateKey);

    const privateKey = await derDeserializeECDHPrivateKey(stubKeyDer, ecdhCurveName);

    expect(privateKey).toBe(stubKeyPair.privateKey);
    expect(mockImportKey).toBeCalledTimes(1);
    expect(mockImportKey).toBeCalledWith(
      'pkcs8',
      bufferToArray(stubKeyDer),
      { name: 'ECDH', namedCurve: ecdhCurveName },
      true,
      ['deriveBits', 'deriveKey'],
    );
  });

  test('derDeserializeECDHPrivateKey should default to P-256', async () => {
    mockImportKey.mockResolvedValueOnce(stubKeyPair.privateKey);

    await derDeserializeECDHPrivateKey(stubKeyDer);

    expect(mockImportKey).toBeCalledTimes(1);
    const algorithm = mockImportKey.mock.calls[0][2];
    expect(algorithm).toHaveProperty('namedCurve', 'P-256');
  });
});

test('getPublicKeyDigest should return the SHA-256 digest of the public key', async () => {
  const keyPair = await generateRSAKeyPair();

  const digest = await getPublicKeyDigest(keyPair.publicKey);

  expect(Buffer.from(digest)).toEqual(
    createHash('sha256')
      .update(await derSerializePublicKey(keyPair.publicKey))
      .digest(),
  );
});

test('getPublicKeyDigest should return the SHA-256 hex digest of the public key', async () => {
  const keyPair = await generateRSAKeyPair();

  const digestHex = await getPublicKeyDigestHex(keyPair.publicKey);

  expect(digestHex).toEqual(sha256Hex(await derSerializePublicKey(keyPair.publicKey)));
});

describe('getPrivateAddressFromIdentityKey', () => {
  test('Private address should be computed from identity key', async () => {
    const keyPair = await generateRSAKeyPair();

    const privateAddress = await getPrivateAddressFromIdentityKey(keyPair.publicKey);

    expect(privateAddress).toEqual('0' + sha256Hex(await derSerializePublicKey(keyPair.publicKey)));
  });

  test('DH keys should be refused', async () => {
    const keyPair = await generateECDHKeyPair();

    await expect(getPrivateAddressFromIdentityKey(keyPair.publicKey)).rejects.toThrowWithMessage(
      Error,
      'Only RSA keys are supported (got ECDH)',
    );
  });
});
