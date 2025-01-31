// tslint:disable:no-object-mutation max-classes-per-file

import * as asn1js from 'asn1js';
import bufferToArray from 'buffer-to-arraybuffer';
import * as pkijs from 'pkijs';

import { CMS_OIDS, RELAYNET_OIDS } from '../../oids';
import { SessionKey } from '../../SessionKey';
import { generateRandom64BitValue, getPkijsCrypto } from '../_utils';
import { derDeserializeECDHPublicKey, derSerializePrivateKey } from '../keys';
import Certificate from '../x509/Certificate';
import { assertPkiType, assertUndefined, deserializeContentInfo } from './_utils';
import CMSError from './CMSError';

const pkijsCrypto = getPkijsCrypto();

// CBC mode is temporary. See: https://github.com/relaycorp/relayverse/issues/16
const AES_CIPHER_MODE = 'AES-CBC';
const AES_KEY_SIZES: ReadonlyArray<number> = [128, 192, 256];

export interface EncryptionOptions {
  /** The AES key size (128, 192 or 256) */
  readonly aesKeySize: number;
}

/**
 * Result of producing an EnvelopedData value with the Channel Session Protocol.
 */
export interface SessionEncryptionResult {
  /** Id of ECDH key pair. */
  readonly dhKeyId: ArrayBuffer;

  /** Private key of the ECDH key pair */
  readonly dhPrivateKey: CryptoKey;

  /** EnvelopedData value using the Channel Session Protocol. */
  readonly envelopedData: SessionEnvelopedData;
}

export abstract class EnvelopedData {
  /**
   * Deserialize an EnvelopedData value into a `SessionlessEnvelopedData` or `SessionEnvelopedData`
   * instance.
   *
   * Depending on the type of RecipientInfo.
   *
   * @param envelopedDataSerialized
   */
  public static deserialize(envelopedDataSerialized: ArrayBuffer): EnvelopedData {
    const contentInfo = deserializeContentInfo(envelopedDataSerialized);
    if (contentInfo.contentType !== CMS_OIDS.ENVELOPED_DATA) {
      throw new CMSError(
        `ContentInfo does not wrap an EnvelopedData value (got OID ${contentInfo.contentType})`,
      );
    }
    let pkijsEnvelopedData;
    try {
      pkijsEnvelopedData = new pkijs.EnvelopedData({ schema: contentInfo.content });
    } catch (error) {
      throw new CMSError(error as Error, 'Invalid EnvelopedData value');
    }
    const recipientInfosLength = pkijsEnvelopedData.recipientInfos.length;
    if (recipientInfosLength !== 1) {
      throw new CMSError(
        `EnvelopedData must have exactly one RecipientInfo (got ${recipientInfosLength})`,
      );
    }

    const recipientInfo = pkijsEnvelopedData.recipientInfos[0];
    if (![1, 2].includes(recipientInfo.variant)) {
      throw new CMSError(`Unsupported RecipientInfo (variant: ${recipientInfo.variant})`);
    }
    const envelopedDataClass =
      recipientInfo.variant === 1 ? SessionlessEnvelopedData : SessionEnvelopedData;
    return new envelopedDataClass(pkijsEnvelopedData);
  }

  /**
   * @internal
   */
  public readonly pkijsEnvelopedData: pkijs.EnvelopedData;

  /**
   * @internal
   */
  protected constructor(pkijsEnvelopedData: pkijs.EnvelopedData) {
    this.pkijsEnvelopedData = pkijsEnvelopedData;
  }

  /**
   * Return the DER serialization of the current EnvelopedData value.
   *
   * It'll be wrapped around a `ContentInfo` value.
   */
  public serialize(): ArrayBuffer {
    const contentInfo = new pkijs.ContentInfo({
      content: this.pkijsEnvelopedData.toSchema(),
      contentType: CMS_OIDS.ENVELOPED_DATA,
    });
    return contentInfo.toSchema().toBER(false);
  }

  /**
   * Return the plaintext for the ciphertext contained in the current EnvelopedData value.
   *
   * @param privateKey The private key to decrypt the ciphertext.
   */
  public async decrypt(privateKey: CryptoKey): Promise<ArrayBuffer> {
    const privateKeyDer = await derSerializePrivateKey(privateKey);
    try {
      return await this.pkijsEnvelopedData.decrypt(0, {
        recipientPrivateKey: bufferToArray(privateKeyDer),
      });
    } catch (error) {
      throw new CMSError(error as Error, 'Decryption failed');
    }
  }

  /**
   * Return the id of the recipient's key used to encrypt the content.
   *
   * This id will often be the recipient's certificate's serial number, in which case the issuer
   * will be ignored: This method is meant to be used by the recipient so it can look up the
   * corresponding private key to decrypt the content. We could certainly extract the issuer to
   * verify it matches the expected one, but if the id doesn't match any key decryption
   * won't even be attempted, so there's really no risk from ignoring the issuer.
   */
  public abstract getRecipientKeyId(): Buffer;
}

/**
 * CMS EnvelopedData representation that doesn't use the Channel Session Protocol.
 *
 * Consequently, it uses the key transport choice (`KeyTransRecipientInfo`) from CMS.
 */
export class SessionlessEnvelopedData extends EnvelopedData {
  /**
   * Return an EnvelopedData value without using the Channel Session Protocol.
   *
   * @param plaintext The plaintext whose ciphertext has to be embedded in the EnvelopedData value.
   * @param certificate The certificate for the recipient.
   * @param options Any encryption options.
   */
  public static async encrypt(
    plaintext: ArrayBuffer,
    certificate: Certificate,
    options: Partial<EncryptionOptions> = {},
  ): Promise<SessionlessEnvelopedData> {
    const pkijsEnvelopedData = new pkijs.EnvelopedData();

    pkijsEnvelopedData.addRecipientByCertificate(
      certificate.pkijsCertificate,
      { oaepHashAlgorithm: 'SHA-256' },
      1,
    );

    const aesKeySize = getAesKeySize(options.aesKeySize);
    await pkijsEnvelopedData.encrypt(
      { name: AES_CIPHER_MODE, length: aesKeySize } as any,
      plaintext,
    );

    return new SessionlessEnvelopedData(pkijsEnvelopedData);
  }

  public getRecipientKeyId(): Buffer {
    const recipientInfo = this.pkijsEnvelopedData.recipientInfos[0].value;
    assertPkiType(recipientInfo, pkijs.KeyTransRecipientInfo, 'recipientInfo');
    assertPkiType(recipientInfo.rid, pkijs.IssuerAndSerialNumber, 'recipientInfo.rid');
    const serialNumberBlock = recipientInfo.rid.serialNumber;
    return Buffer.from(serialNumberBlock.valueBlock.valueHexView);
  }
}

function getAesKeySize(aesKeySize: number | undefined): number {
  if (aesKeySize && !AES_KEY_SIZES.includes(aesKeySize)) {
    throw new CMSError(`Invalid AES key size (${aesKeySize})`);
  }
  return aesKeySize || 128;
}

/**
 * CMS EnvelopedData representation using the Channel Session Protocol.
 *
 * Consequently, it uses the key agreement (`KeyAgreeRecipientInfo`) from CMS.
 */
export class SessionEnvelopedData extends EnvelopedData {
  /**
   * Return an EnvelopedData value using the Channel Session Protocol.
   *
   * @param plaintext The plaintext whose ciphertext has to be embedded in the EnvelopedData value.
   * @param recipientSessionKey The ECDH public key of the recipient.
   * @param options Any encryption options.
   */
  public static async encrypt(
    plaintext: ArrayBuffer,
    recipientSessionKey: SessionKey,
    options: Partial<EncryptionOptions> = {},
  ): Promise<SessionEncryptionResult> {
    // Generate id for generated (EC)DH key and attach it to unprotectedAttrs per RS-003:
    const dhKeyId = generateRandom64BitValue();
    const dhKeyIdAttribute = new pkijs.Attribute({
      type: RELAYNET_OIDS.ORIGINATOR_EPHEMERAL_CERT_SERIAL_NUMBER,
      values: [new asn1js.OctetString({ valueHex: dhKeyId })],
    });

    const pkijsEnvelopedData = new pkijs.EnvelopedData({
      unprotectedAttrs: [dhKeyIdAttribute],
    });

    pkijsEnvelopedData.addRecipientByKeyIdentifier(
      recipientSessionKey.publicKey,
      recipientSessionKey.keyId,
    );

    const aesKeySize = getAesKeySize(options.aesKeySize);
    const [pkijsEncryptionResult] = await pkijsEnvelopedData.encrypt(
      { name: AES_CIPHER_MODE, length: aesKeySize } as any,
      plaintext,
    );
    assertUndefined(pkijsEncryptionResult, 'pkijsEncryptionResult');
    const dhPrivateKey = pkijsEncryptionResult.ecdhPrivateKey;

    const envelopedData = new SessionEnvelopedData(pkijsEnvelopedData);
    return { dhPrivateKey, dhKeyId, envelopedData };
  }

  /**
   * Return the key of the ECDH key of the originator/producer of the EnvelopedData value.
   */
  public async getOriginatorKey(): Promise<SessionKey> {
    const keyId = extractOriginatorKeyId(this.pkijsEnvelopedData);

    const recipientInfo = this.pkijsEnvelopedData.recipientInfos[0];
    if (recipientInfo.variant !== 2) {
      throw new CMSError(`Expected KeyAgreeRecipientInfo (got variant: ${recipientInfo.variant})`);
    }
    assertPkiType(recipientInfo.value, pkijs.KeyAgreeRecipientInfo, 'recipientInfo.value');
    const originator = recipientInfo.value.originator.value;
    const publicKeyDer = originator.toSchema().toBER(false);

    const curveOid = originator.algorithm.algorithmParams.valueBlock.toString();
    // @ts-ignore
    const curveParams = pkijsCrypto.getAlgorithmByOID(curveOid);
    const publicKey = await derDeserializeECDHPublicKey(
      Buffer.from(publicKeyDer),
      curveParams.name,
    );
    return { keyId, publicKey };
  }

  public getRecipientKeyId(): Buffer {
    const keyInfo = this.pkijsEnvelopedData.recipientInfos[0].value;
    assertPkiType(keyInfo, pkijs.KeyAgreeRecipientInfo, 'keyInfo');
    const encryptedKey = keyInfo.recipientEncryptedKeys.encryptedKeys[0];
    const subjectKeyIdentifierBlock = encryptedKey.rid.value.subjectKeyIdentifier;
    return Buffer.from(subjectKeyIdentifierBlock.valueBlock.valueHex);
  }
}

function extractOriginatorKeyId(envelopedData: pkijs.EnvelopedData): Buffer {
  const unprotectedAttrs = envelopedData.unprotectedAttrs || [];
  if (unprotectedAttrs.length === 0) {
    throw new CMSError('unprotectedAttrs must be present when using channel session');
  }

  const matchingAttrs = unprotectedAttrs.filter(
    (a) => a.type === RELAYNET_OIDS.ORIGINATOR_EPHEMERAL_CERT_SERIAL_NUMBER,
  );
  if (matchingAttrs.length === 0) {
    throw new CMSError('unprotectedAttrs does not contain originator key id');
  }

  const originatorKeyIdAttr = matchingAttrs[0];
  // @ts-ignore
  const originatorKeyIds = originatorKeyIdAttr.values;
  if (originatorKeyIds.length !== 1) {
    throw new CMSError(
      `Originator key id attribute must have exactly one value (got ${originatorKeyIds.length})`,
    );
  }

  const serialNumberBlock = originatorKeyIds[0];
  return Buffer.from(serialNumberBlock.valueBlock.valueHex);
}
