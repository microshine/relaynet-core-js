import * as asn1js from 'asn1js';
import { createHash } from 'crypto';
import * as jestDateMock from 'jest-date-mock';
import * as pkijs from 'pkijs';
import { generateRsaKeys } from '../crypto';
import Certificate from './Certificate';
import CertificateError from './CertificateError';

const RELAYNET_NODE_ADDRESS = 'foo';

const OID_COMMON_NAME = '2.5.4.3';

const cryptoEngine = pkijs.getCrypto();
if (cryptoEngine === undefined) {
  throw new Error('PKI.js crypto engine is undefined');
}

afterEach(() => {
  jest.restoreAllMocks();
  jestDateMock.clear();
});

describe('deserialize', () => {
  test('should support self-signed certificate', async () => {
    const certBuffer = await generateCertBuffer();
    const cert = Certificate.deserialize(certBuffer);
    expect(cert.pkijsCertificate.subject.typesAndValues[0].type).toBe(
      OID_COMMON_NAME
    );
    expect(
      cert.pkijsCertificate.subject.typesAndValues[0].value.valueBlock.value
    ).toBe(RELAYNET_NODE_ADDRESS);
  });

  test('should error out with invalid DER values', () => {
    const invalidDer = Buffer.from('nope');
    expect(() => Certificate.deserialize(invalidDer)).toThrowWithMessage(
      CertificateError,
      'Certificate is not DER-encoded'
    );
  });

  describe('Validation', () => {
    test.todo('X.509 certificates with version != 3 are invalid');
  });
});

describe('issue', () => {
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + 1);

  test('The X.509 certificate version should be 3', async () => {
    const keyPair = await generateRsaKeys();
    const cert = await Certificate.issue(keyPair.privateKey, {
      serialNumber: 1,
      subjectPublicKey: keyPair.publicKey,
      validityEndDate: futureDate
    });

    // v3 is serialized as integer 2
    expect(cert.pkijsCertificate.version).toBe(0x2);
  });

  test('The public key should be imported into the certificate', async () => {
    const keyPair = await generateRsaKeys();
    spyOn(pkijs.PublicKeyInfo.prototype, 'importKey');
    await Certificate.issue(keyPair.privateKey, {
      serialNumber: 1,
      subjectPublicKey: keyPair.publicKey,
      validityEndDate: futureDate
    });

    expect(pkijs.PublicKeyInfo.prototype.importKey).toBeCalledTimes(1);
    expect(pkijs.PublicKeyInfo.prototype.importKey).toBeCalledWith(
      keyPair.publicKey
    );
  });

  test('The certificate is signed with the specified private key', async () => {
    const { privateKey, publicKey } = await generateRsaKeys();
    spyOn(pkijs.Certificate.prototype, 'sign');
    await Certificate.issue(privateKey, {
      serialNumber: 1,
      subjectPublicKey: publicKey,
      validityEndDate: futureDate
    });

    expect(pkijs.Certificate.prototype.sign).toBeCalledTimes(1);
    expect(pkijs.Certificate.prototype.sign).toBeCalledWith(
      privateKey,
      ((privateKey.algorithm as RsaHashedKeyGenParams).hash as Algorithm).name
    );
  });

  test('The serial number should be stored', async () => {
    const keyPair = await generateRsaKeys();
    const serialNumber = 2019;
    const cert = await Certificate.issue(keyPair.privateKey, {
      serialNumber,
      subjectPublicKey: keyPair.publicKey,
      validityEndDate: futureDate
    });

    expect(cert.pkijsCertificate.serialNumber.valueBlock.valueDec).toBe(
      serialNumber
    );
  });

  test('The certificate is valid from now by default', async () => {
    const keyPair = await generateRsaKeys();
    const now = new Date();
    jestDateMock.advanceTo(now);
    const cert = await Certificate.issue(keyPair.privateKey, {
      serialNumber: 1,
      subjectPublicKey: keyPair.publicKey,
      validityEndDate: futureDate
    });

    expect(cert.pkijsCertificate.notBefore.value).toEqual(now);
  });

  test('The certificate start date should be customizable', async () => {
    const keyPair = await generateRsaKeys();
    const startDate = new Date(2019, 1, 1);
    const cert = await Certificate.issue(keyPair.privateKey, {
      serialNumber: 1,
      subjectPublicKey: keyPair.publicKey,
      validityEndDate: futureDate,
      validityStartDate: startDate
    });

    expect(cert.pkijsCertificate.notBefore.value).toBe(startDate);
  });

  test('The end date should be stored', async () => {
    const keyPair = await generateRsaKeys();
    const cert = await Certificate.issue(keyPair.privateKey, {
      serialNumber: 1,
      subjectPublicKey: keyPair.publicKey,
      validityEndDate: futureDate
    });

    expect(cert.pkijsCertificate.notAfter.value).toBe(futureDate);
  });

  test('The end date should not come before the start date', async () => {
    const keyPair = await generateRsaKeys();
    const attributes = {
      serialNumber: 1,
      subjectPublicKey: keyPair.publicKey,
      validityEndDate: new Date(2000, 1, 1)
    };
    await expect(
      Certificate.issue(keyPair.privateKey, attributes)
    ).rejects.toThrow('The end date must be later than the start date');
  });

  test('Subject CN should correspond to private node if public address is missing', async () => {
    const { privateKey, publicKey } = await generateRsaKeys();
    const cert = await Certificate.issue(privateKey, {
      serialNumber: 1,
      subjectPublicKey: publicKey,
      validityEndDate: futureDate
    });

    const publicKeyDer = Buffer.from(
      await cryptoEngine.exportKey('spki', publicKey)
    );
    const publicKeyHash = createHash('sha256')
      .update(publicKeyDer)
      .digest('hex');
    const subjectDnAttributes = cert.pkijsCertificate.subject.typesAndValues;
    expect(subjectDnAttributes.length).toBe(1);
    expect(subjectDnAttributes[0].type).toBe(OID_COMMON_NAME);
    expect(subjectDnAttributes[0].value.valueBlock.value).toBe(
      `0${publicKeyHash}`
    );
  });

  test.todo('Subject CN should contain public address if present');

  test.todo('Issuer DN should be stored');
});

async function generateCertBuffer(): Promise<Buffer> {
  const certificate = new pkijs.Certificate({
    serialNumber: new asn1js.Integer({ value: 1 }),
    version: 2
  });
  // tslint:disable-next-line:no-object-mutation
  certificate.notBefore.value = new Date(2016, 1, 1);

  // tslint:disable-next-line:no-object-mutation
  certificate.notAfter.value = new Date(2029, 1, 1);
  const keyPair = await generateRsaKeys();

  await certificate.subjectPublicKeyInfo.importKey(keyPair.publicKey);
  certificate.issuer.typesAndValues.push(
    new pkijs.AttributeTypeAndValue({
      type: OID_COMMON_NAME,
      value: new asn1js.BmpString({ value: RELAYNET_NODE_ADDRESS })
    })
  );

  certificate.subject.typesAndValues.push(
    new pkijs.AttributeTypeAndValue({
      type: OID_COMMON_NAME,
      value: new asn1js.BmpString({ value: RELAYNET_NODE_ADDRESS })
    })
  );

  await certificate.sign(keyPair.privateKey, 'SHA-256');
  return Buffer.from(certificate.toSchema(true).toBER(false));
}