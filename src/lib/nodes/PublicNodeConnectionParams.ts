import { Constructed, OctetString, Primitive, Sequence, verifySchema, VisibleString } from 'asn1js';
import bufferToArray from 'buffer-to-arraybuffer';
import isValidDomain from 'is-valid-domain';
import { TextDecoder } from 'util';

import { makeHeterogeneousSequenceSchema, makeImplicitlyTaggedSequence } from '../asn1';
import {
  derDeserializeECDHPublicKey,
  derDeserializeRSAPublicKey,
  derSerializePublicKey,
} from '../crypto_wrappers/keys';
import { SessionKey } from '../SessionKey';
import { InvalidPublicNodeConnectionParams } from './errors';

export class PublicNodeConnectionParams {
  public static async deserialize(serialization: ArrayBuffer): Promise<PublicNodeConnectionParams> {
    const result = verifySchema(serialization, PublicNodeConnectionParams.SCHEMA);
    if (!result.verified) {
      throw new InvalidPublicNodeConnectionParams(
        'Serialization is not a valid PublicNodeConnectionParams',
      );
    }

    const paramsASN1 = (result.result as any).PublicNodeConnectionParams;

    const textDecoder = new TextDecoder();
    const publicAddress = textDecoder.decode(paramsASN1.publicAddress.valueBlock.valueHex);
    if (!isValidDomain(publicAddress)) {
      throw new InvalidPublicNodeConnectionParams(
        `Public address is syntactically invalid (${publicAddress})`,
      );
    }

    let identityKey: CryptoKey;
    try {
      identityKey = await derDeserializeRSAPublicKey(paramsASN1.identityKey.valueBlock.valueHex);
    } catch (err: any) {
      throw new InvalidPublicNodeConnectionParams(
        new Error(err), // The original error could be a string 🤦
        'Identity key is not a valid RSA public key',
      );
    }

    const sessionKeySequence = paramsASN1.sessionKey as Sequence;
    if (sessionKeySequence.valueBlock.value.length < 2) {
      throw new InvalidPublicNodeConnectionParams('Session key should have at least two items');
    }
    const sessionKeyId = (sessionKeySequence.valueBlock.value[0] as Primitive).valueBlock.valueHex;
    const sessionPublicKeyASN1 = sessionKeySequence.valueBlock.value[1] as Primitive;
    let sessionPublicKey: CryptoKey;
    try {
      sessionPublicKey = await derDeserializeECDHPublicKey(
        sessionPublicKeyASN1.valueBlock.valueHex,
      );
    } catch (err: any) {
      throw new InvalidPublicNodeConnectionParams(
        new Error(err), // The original error could be a string 🤦
        'Session key is not a valid ECDH public key',
      );
    }

    return new PublicNodeConnectionParams(publicAddress, identityKey, {
      keyId: Buffer.from(sessionKeyId),
      publicKey: sessionPublicKey,
    });
  }

  private static readonly SCHEMA = makeHeterogeneousSequenceSchema('PublicNodeConnectionParams', [
    new Primitive({ name: 'publicAddress' }),
    new Primitive({ name: 'identityKey' }),
    new Constructed({
      name: 'sessionKey',
      value: [
        new Primitive({ idBlock: { tagClass: 3, tagNumber: 0 } } as any),
        new Primitive({ idBlock: { tagClass: 3, tagNumber: 1 } } as any),
      ],
    } as any),
  ]);

  constructor(
    public readonly publicAddress: string,
    public readonly identityKey: CryptoKey,
    public readonly sessionKey: SessionKey,
  ) {}

  public async serialize(): Promise<ArrayBuffer> {
    const identityKeySerialized = await derSerializePublicKey(this.identityKey);

    const sessionPublicKeySerialized = await derSerializePublicKey(this.sessionKey.publicKey);
    const sessionKeySequence = makeImplicitlyTaggedSequence(
      new OctetString({ valueHex: bufferToArray(this.sessionKey.keyId) }),
      new OctetString({ valueHex: bufferToArray(sessionPublicKeySerialized) }),
    );

    return makeImplicitlyTaggedSequence(
      new VisibleString({ value: this.publicAddress }),
      new OctetString({ valueHex: bufferToArray(identityKeySerialized) }),
      sessionKeySequence,
    ).toBER();
  }
}
