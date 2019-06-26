import * as asn1js from 'asn1js';
import { createHash } from 'crypto';
import * as pkijs from 'pkijs';
import { generateRsaKeys } from './crypto';
import Certificate from './pki/Certificate';
import CertificateAttributes from './pki/CertificateAttributes';

export function asn1DerDecode(asn1Value: ArrayBuffer): asn1js.LocalBaseBlock {
  const asn1 = asn1js.fromBER(asn1Value);
  expect(asn1.offset).not.toEqual(-1);
  return asn1.result;
}

type PkijsValueType = pkijs.RelativeDistinguishedNames;

export function expectPkijsValuesToBeEqual(
  value1: PkijsValueType,
  value2: PkijsValueType
): void {
  expectAsn1ValuesToBeEqual(value1.toSchema(), value2.toSchema());
}

type Asn1jsToBER = (sizeOnly?: boolean) => ArrayBuffer;

interface Asn1jsSerializable {
  readonly toBER: Asn1jsToBER;
}

export function expectAsn1ValuesToBeEqual(
  value1: Asn1jsSerializable,
  value2: Asn1jsSerializable
): void {
  expect(sha256Hex(value1.toBER(false))).toEqual(
    sha256Hex(value2.toBER(false))
  );
}

interface StubCertConfig {
  readonly attributes?: Partial<CertificateAttributes>;
  readonly issuerPrivateKey?: CryptoKey;
  readonly subjectPublicKey?: CryptoKey;
}

export async function generateStubCert(
  config: StubCertConfig = {}
): Promise<Certificate> {
  const keyPair = await generateRsaKeys();
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + 1);
  return Certificate.issue(config.issuerPrivateKey || keyPair.privateKey, {
    serialNumber: 1,
    subjectPublicKey: config.subjectPublicKey || keyPair.publicKey,
    validityEndDate: futureDate,
    ...config.attributes
  });
}

export function sha256Hex(plaintext: ArrayBuffer): string {
  return createHash('sha256')
    .update(Buffer.from(plaintext))
    .digest('hex');
}
