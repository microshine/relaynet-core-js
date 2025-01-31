import { mockSpy } from '../../_test_utils';
import { MockKeyStoreSet } from '../../keyStores/testMocks';
import * as privateGatewayModule from '../PrivateGateway';
import { PrivateGatewayManager } from './PrivateGatewayManager';

const MOCK_PRIVATE_GATEWAY_CLASS = mockSpy(jest.spyOn(privateGatewayModule, 'PrivateGateway'));

const KEY_STORES = new MockKeyStoreSet();
afterEach(() => {
  KEY_STORES.clear();
});

describe('get', () => {
  test('Null should be returned if the private key does not exist', async () => {
    const manager = new PrivateGatewayManager(KEY_STORES);

    await expect(manager.get('non-existing')).resolves.toBeNull();
  });

  test('Node should be returned if private key exists', async () => {
    const { privateKey, privateAddress } =
      await KEY_STORES.privateKeyStore.generateIdentityKeyPair();
    const manager = new PrivateGatewayManager(KEY_STORES);

    const gateway = await manager.get(privateAddress);

    expect(MOCK_PRIVATE_GATEWAY_CLASS).toBeCalledWith(privateAddress, privateKey, KEY_STORES, {});
    expect(gateway).toEqual(MOCK_PRIVATE_GATEWAY_CLASS.mock.instances[0]);
  });

  test('Key stores should be passed on', async () => {
    const { privateAddress } = await KEY_STORES.privateKeyStore.generateIdentityKeyPair();
    const manager = new PrivateGatewayManager(KEY_STORES);

    await manager.get(privateAddress);

    expect(MOCK_PRIVATE_GATEWAY_CLASS).toBeCalledWith(
      expect.anything(),
      expect.anything(),
      KEY_STORES,
      expect.anything(),
    );
  });

  test('Crypto options should be honoured if passed', async () => {
    const { privateAddress } = await KEY_STORES.privateKeyStore.generateIdentityKeyPair();
    const cryptoOptions = { encryption: { aesKeySize: 256 } };
    const manager = new PrivateGatewayManager(KEY_STORES, cryptoOptions);

    await manager.get(privateAddress);

    expect(MOCK_PRIVATE_GATEWAY_CLASS).toBeCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      cryptoOptions,
    );
  });

  test('Custom PrivateGateway subclass should be used if applicable', async () => {
    const customPrivateGateway = {};
    const customPrivateGatewayConstructor = jest.fn().mockReturnValue(customPrivateGateway);
    const manager = new PrivateGatewayManager(KEY_STORES);
    const { privateKey, privateAddress } =
      await KEY_STORES.privateKeyStore.generateIdentityKeyPair();

    const gateway = await manager.get(privateAddress, customPrivateGatewayConstructor);

    expect(gateway).toBe(customPrivateGateway);
    expect(customPrivateGatewayConstructor).toBeCalledWith(
      privateAddress,
      privateKey,
      KEY_STORES,
      {},
    );
  });
});
