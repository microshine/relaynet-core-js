import * as asn1js from 'asn1js';
import bufferToArray from 'buffer-to-arraybuffer';
import { TextDecoder } from 'util';

import { SignatureOptions } from '../..';
import {
  asn1DateTimeToDate,
  dateToASN1DateTimeInUTC,
  makeHeterogeneousSequenceSchema,
  makeImplicitlyTaggedSequence,
} from '../asn1';
import * as cmsSignedData from '../crypto_wrappers/cms/signedData';
import { generateFormatSignature } from '../messages/formatSignature';
import RAMFMessage from '../messages/RAMFMessage';
import RAMFSyntaxError from './RAMFSyntaxError';
import RAMFValidationError from './RAMFValidationError';

/**
 * Maximum length of any RAMF message per RS-001.
 *
 * https://specs.relaynet.network/RS-001
 */
export const MAX_RAMF_MESSAGE_LENGTH = 9437184; // 9 MiB

const MAX_RECIPIENT_ADDRESS_LENGTH = 1024;
const MAX_ID_LENGTH = 64;
export const RAMF_MAX_TTL = 15552000;
const MAX_PAYLOAD_LENGTH = 2 ** 23 - 1; // 8 MiB

const PRIVATE_ADDRESS_REGEX = /^[a-f0-9]+$/;

/**
 * Maximum length of any SDU to be encapsulated in a CMS EnvelopedData value, per the RAMF spec.
 */
export const MAX_SDU_PLAINTEXT_LENGTH = 8322048;

const FORMAT_SIGNATURE_CONSTANT = Buffer.from('Relaynet');

interface MessageFormatSignature {
  readonly concreteMessageType: number;
  readonly concreteMessageVersion: number;
}

interface MessageFieldSet {
  readonly recipientAddress: string;
  readonly id: string;
  readonly date: Date;
  readonly ttl: number;
  readonly payload: Buffer;
}

const ASN1_SCHEMA = makeHeterogeneousSequenceSchema('RAMFMessage', [
  new asn1js.Primitive({ name: 'recipientAddress' }),
  new asn1js.Primitive({ name: 'id' }),
  new asn1js.Primitive({ name: 'date' }),
  new asn1js.Primitive({ name: 'ttl' }),
  new asn1js.Primitive({ name: 'payload' }),
]);

/**
 * Sign and encode the current message.
 *
 * @param message The message to serialize.
 * @param concreteMessageTypeOctet
 * @param concreteMessageVersionOctet
 * @param senderPrivateKey The private key to sign the message.
 * @param signatureOptions Any signature options.
 */
export async function serialize(
  message: RAMFMessage<any>,
  concreteMessageTypeOctet: number,
  concreteMessageVersionOctet: number,
  senderPrivateKey: CryptoKey,
  signatureOptions?: Partial<SignatureOptions>,
): Promise<ArrayBuffer> {
  //region Validation
  validateRecipientAddressLength(message.recipientAddress);
  validateMessageIdLength(message.id);
  validateTtl(message.ttl);
  validatePayloadLength(message.payloadSerialized);
  //endregion

  const formatSignature = generateFormatSignature(
    concreteMessageTypeOctet,
    concreteMessageVersionOctet,
  );

  const fieldSetSerialized = makeImplicitlyTaggedSequence(
    new asn1js.VisibleString({ value: message.recipientAddress }),
    new asn1js.VisibleString({ value: message.id }),
    dateToASN1DateTimeInUTC(message.creationDate),
    new asn1js.Integer({ value: message.ttl }),
    new asn1js.OctetString({ valueHex: bufferToArray(message.payloadSerialized) }),
  ).toBER();

  //region Signature
  const signature = await cmsSignedData.sign(
    fieldSetSerialized,
    senderPrivateKey,
    message.senderCertificate,
    message.senderCaCertificateChain,
    signatureOptions,
  );
  //endregion

  // There doesn't seem to be an efficient way to concatenate ArrayBuffer instances, so we'll have
  // to make a copy of the signature (which already contains a copy of the payload). So by the end
  // of this function we'll need more than 3x the size of the payload in memory. This issue will
  // go away with https://github.com/relaynet/specs/issues/14
  const serialization = new ArrayBuffer(formatSignature.byteLength + signature.byteLength);
  const serializationView = new Uint8Array(serialization);
  serializationView.set(formatSignature, 0);
  serializationView.set(new Uint8Array(signature), formatSignature.byteLength);
  return serialization;
}

function validateMessageLength(serialization: ArrayBuffer): void {
  if (MAX_RAMF_MESSAGE_LENGTH < serialization.byteLength) {
    throw new RAMFSyntaxError(
      `Message should not be longer than 9 MiB (got ${serialization.byteLength} octets)`,
    );
  }
}

export async function deserialize<M extends RAMFMessage<any>>(
  serialization: ArrayBuffer,
  concreteMessageTypeOctet: number,
  concreteMessageVersionOctet: number,
  messageClass: new (...args: readonly any[]) => M,
): Promise<M> {
  validateMessageLength(serialization);
  const messageFormatSignature = parseMessageFormatSignature(serialization.slice(0, 10));
  validateFileFormatSignature(
    messageFormatSignature,
    concreteMessageTypeOctet,
    concreteMessageVersionOctet,
  );

  const signatureVerification = await verifySignature(serialization.slice(10));

  const messageFields = parseMessageFields(signatureVerification.plaintext);
  validateRecipientAddressLength(messageFields.recipientAddress);
  validateRecipientAddress(messageFields.recipientAddress);
  validateMessageIdLength(messageFields.id);
  validateTtl(messageFields.ttl);
  validatePayloadLength(messageFields.payload);

  return new messageClass(
    messageFields.recipientAddress,
    signatureVerification.signerCertificate,
    messageFields.payload,
    {
      creationDate: messageFields.date,
      id: messageFields.id,
      senderCaCertificateChain: signatureVerification.attachedCertificates,
      ttl: messageFields.ttl,
    },
  );
}

function decimalToHex(numberDecimal: number): string {
  return '0x' + numberDecimal.toString(16);
}

//region Serialization and deserialization validation

function validateFileFormatSignature(
  messageFields: MessageFormatSignature,
  concreteMessageTypeOctet: number,
  concreteMessageVersionOctet: number,
): void {
  //region Message type validation
  if (messageFields.concreteMessageType !== concreteMessageTypeOctet) {
    const expectedMessageTypeHex = decimalToHex(concreteMessageTypeOctet);
    const actualMessageTypeHex = decimalToHex(messageFields.concreteMessageType);
    throw new RAMFSyntaxError(
      `Expected concrete message type ${expectedMessageTypeHex} but got ${actualMessageTypeHex}`,
    );
  }
  //endregion

  //region Message version validation
  if (messageFields.concreteMessageVersion !== concreteMessageVersionOctet) {
    const expectedVersionHex = decimalToHex(concreteMessageVersionOctet);
    const actualVersionHex = decimalToHex(messageFields.concreteMessageVersion);
    throw new RAMFSyntaxError(
      `Expected concrete message version ${expectedVersionHex} but got ${actualVersionHex}`,
    );
  }
  //endregion
}

function validateRecipientAddress(recipientAddress: string): void {
  try {
    // tslint:disable-next-line:no-unused-expression
    new URL(recipientAddress);
  } catch (_) {
    // The address isn't public. Check if it's private:
    if (!recipientAddress.match(PRIVATE_ADDRESS_REGEX)) {
      throw new RAMFValidationError(
        `Recipient address should be a valid node address (got: "${recipientAddress}")`,
      );
    }
  }
}

function validateRecipientAddressLength(recipientAddress: string): void {
  const length = recipientAddress.length;
  if (MAX_RECIPIENT_ADDRESS_LENGTH < length) {
    throw new RAMFSyntaxError(
      `Recipient address should not span more than ${MAX_RECIPIENT_ADDRESS_LENGTH} characters ` +
        `(got ${length})`,
    );
  }
}

function validateMessageIdLength(messageId: string): void {
  const length = messageId.length;
  if (MAX_ID_LENGTH < length) {
    throw new RAMFSyntaxError(
      `Id should not span more than ${MAX_ID_LENGTH} characters (got ${length})`,
    );
  }
}

function validateTtl(ttl: number): void {
  if (ttl < 0) {
    throw new RAMFSyntaxError('TTL cannot be negative');
  }
  if (RAMF_MAX_TTL < ttl) {
    throw new RAMFSyntaxError(`TTL must be less than ${RAMF_MAX_TTL} (got ${ttl})`);
  }
}

function validatePayloadLength(payloadBuffer: ArrayBuffer): void {
  const length = payloadBuffer.byteLength;
  if (MAX_PAYLOAD_LENGTH < length) {
    throw new RAMFSyntaxError(`Payload size must not exceed 8 MiB (got ${length} octets)`);
  }
}

//endregion

//region Deserialization validation

function parseMessageFormatSignature(serialization: ArrayBuffer): MessageFormatSignature {
  if (serialization.byteLength < 10) {
    throw new RAMFSyntaxError('Serialization is too small to contain RAMF format signature');
  }
  const formatSignature = Buffer.from(serialization.slice(0, 10));
  if (!FORMAT_SIGNATURE_CONSTANT.equals(formatSignature.slice(0, 8))) {
    throw new RAMFSyntaxError('RAMF format signature does not begin with "Relaynet"');
  }
  return { concreteMessageType: formatSignature[8], concreteMessageVersion: formatSignature[9] };
}

function parseMessageFields(serialization: ArrayBuffer): MessageFieldSet {
  const result = asn1js.verifySchema(serialization, ASN1_SCHEMA);
  if (!result.verified) {
    throw new RAMFSyntaxError('Invalid RAMF fields');
  }
  const messageBlock = result.result.RAMFMessage;
  const textDecoder = new TextDecoder();
  const ttlBigInt = getIntegerFromPrimitiveBlock(messageBlock.ttl);
  return {
    date: getDateFromPrimitiveBlock(messageBlock.date),
    id: textDecoder.decode(messageBlock.id.valueBlock.valueHex),
    payload: Buffer.from(messageBlock.payload.valueBlock.valueHex),
    recipientAddress: textDecoder.decode(messageBlock.recipientAddress.valueBlock.valueHex),
    ttl: Number(ttlBigInt), // Cannot exceed Number.MAX_SAFE_INTEGER anyway
  };
}

function getDateFromPrimitiveBlock(block: asn1js.Primitive): Date {
  try {
    return asn1DateTimeToDate(block);
  } catch (exc) {
    throw new RAMFValidationError(exc as Error, 'Message date is invalid');
  }
}

function getIntegerFromPrimitiveBlock(block: asn1js.Primitive): bigint {
  const integerBlock = new asn1js.Integer({ valueHex: block.valueBlock.valueHexView });
  return integerBlock.toBigInt();
}

async function verifySignature(
  cmsSignedDataSerialized: ArrayBuffer,
): Promise<cmsSignedData.SignatureVerification> {
  try {
    return await cmsSignedData.verifySignature(cmsSignedDataSerialized);
  } catch (error) {
    throw new RAMFValidationError(error as Error, 'Invalid RAMF message signature');
  }
}

//endregion
