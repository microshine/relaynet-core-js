import bufferToArray from 'buffer-to-arraybuffer';
import Cargo from '../../messages/Cargo';
import CargoMessageSet, { MessageWithExpiryDate } from '../../messages/payloads/CargoMessageSet';
import { RAMF_MAX_TTL } from '../../ramf/serialization';
import { CargoMessageStream } from '../CargoMessageStream';
import { Channel } from './Channel';

const CLOCK_DRIFT_TOLERANCE_HOURS = 3;

/**
 * Channel whose node is a gateway.
 */
export abstract class GatewayChannel extends Channel {
  public async *generateCargoes(messages: CargoMessageStream): AsyncIterable<Buffer> {
    const messagesAsArrayBuffers = convertBufferMessagesToArrayBuffer(messages);
    const cargoMessageSets = CargoMessageSet.batchMessagesSerialized(messagesAsArrayBuffers);
    const recipientAddress = this.getOutboundRAMFAddress();
    for await (const { messageSerialized, expiryDate } of cargoMessageSets) {
      const creationDate = getCargoCreationTime();
      const ttl = getSecondsBetweenDates(creationDate, expiryDate);
      const cargo = new Cargo(
        recipientAddress,
        this.nodeDeliveryAuth,
        await this.encryptPayload(messageSerialized),
        { creationDate, ttl: Math.min(ttl, RAMF_MAX_TTL) },
      );
      const cargoSerialized = await cargo.serialize(
        this.nodePrivateKey,
        this.cryptoOptions.signature,
      );
      yield Buffer.from(cargoSerialized);
    }
  }

  protected async encryptPayload(payloadPlaintext: ArrayBuffer): Promise<Buffer> {
    const ciphertext = await this.wrapMessagePayload(payloadPlaintext);
    return Buffer.from(ciphertext);
  }
}

function getCargoCreationTime(): Date {
  const creationDate = new Date();
  creationDate.setMilliseconds(0);
  creationDate.setHours(creationDate.getHours() - CLOCK_DRIFT_TOLERANCE_HOURS);
  return creationDate;
}

async function* convertBufferMessagesToArrayBuffer(
  messages: CargoMessageStream,
): AsyncGenerator<MessageWithExpiryDate> {
  for await (const { message, expiryDate } of messages) {
    yield { expiryDate, messageSerialized: bufferToArray(message) };
  }
}

function getSecondsBetweenDates(date: Date, expiryDate: Date): number {
  return Math.floor((expiryDate.getTime() - date.getTime()) / 1_000);
}
