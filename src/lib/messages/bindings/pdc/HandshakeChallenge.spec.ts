import { Primitive, Sequence } from 'asn1js';
import { arrayBufferFrom, expectBuffersToEqual } from '../../../_test_utils';
import { derDeserialize } from '../../../crypto_wrappers/_utils';
import InvalidMessageError from '../../InvalidMessageError';
import { HandshakeChallenge } from './HandshakeChallenge';

const NONCE = arrayBufferFrom('The nonce');

describe('serialize', () => {
  test('Nonce should be sole item in ASN.1 SEQUENCE', () => {
    const challenge = new HandshakeChallenge(NONCE);

    const serialization = challenge.serialize();

    const sequence = derDeserialize(serialization);
    expect(sequence).toBeInstanceOf(Sequence);
    expectBuffersToEqual(
      NONCE,
      ((sequence as Sequence).valueBlock.value[0] as Primitive).valueBlock.valueHex,
    );
  });
});

describe('deserialized', () => {
  test('Invalid serialization should be refused', () => {
    const invalidSerialization = arrayBufferFrom('I am a "challenge" :wink: :wink:');

    expect(() => HandshakeChallenge.deserialize(invalidSerialization)).toThrowWithMessage(
      InvalidMessageError,
      'Handshake challenge is malformed',
    );
  });

  test('Valid serialization should be accepted', () => {
    const challenge = new HandshakeChallenge(NONCE);
    const serialization = challenge.serialize();

    const challengeDeserialized = HandshakeChallenge.deserialize(serialization);

    expectBuffersToEqual(NONCE, challengeDeserialized.nonce);
  });
});
