import { describe, expect, it } from 'vitest';
import { describeFailure } from './errors';
// The real class, not a mock: the point of the module is that it reads a rejection the
// indexer actually built, and the structural case below proves the mocked shape works too.
import { EnvioError, type EnvioErrorKind } from './envio/client';
import { CallableError } from './api/functions';
import { en, ko } from './copy';

/** The table a screen hands in: the server's reasons that are worth a sentence of their own. */
const TABLE = { NOT_ACTIVE: '가입을 먼저 마무리해 주세요', ORG_LIMIT: '주최사는 3개까지 만들 수 있어요' };

/**
 * jsdom serves `onLine` from `Navigator.prototype`, so an own property shadows it for the
 * length of one call and deleting that property puts the real getter back. Every offline test
 * runs inside this, so no test can leave the browser offline for the next one.
 */
function whileOffline<T>(run: () => T): T {
  Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
  try {
    return run();
  } finally {
    Reflect.deleteProperty(navigator, 'onLine');
  }
}

describe('step 1 · offline outranks everything', () => {
  it('reads a dropped connection as the phone, not as the indexer', () => {
    const said = whileOffline(() => describeFailure(new EnvioError('network', 'REQUEST_FAILED'), ko));
    expect(said).toBe(ko.common.offlineRetry);
    // The same rejection with the connection back says something else entirely — which is why
    // this step has to come first.
    expect(describeFailure(new EnvioError('network', 'REQUEST_FAILED'), ko)).toBe(ko.common.fetchFailed);
  });

  it('outranks an indexer that really did answer badly', () => {
    expect(whileOffline(() => describeFailure(new EnvioError('http', 'HTTP_503', 503), ko)))
      .toBe(ko.common.offlineRetry);
  });

  it('outranks a reason the caller named', () => {
    const failure = new CallableError('failed-precondition', 'NOT_ACTIVE');
    expect(whileOffline(() => describeFailure(failure, ko, TABLE))).toBe(ko.common.offlineRetry);
    expect(describeFailure(failure, ko, TABLE)).toBe(TABLE.NOT_ACTIVE);
  });

  it('puts the real `onLine` back', () => {
    whileOffline(() => undefined);
    expect(navigator.onLine).toBe(true);
  });
});

describe('steps 2 and 3 · what the indexer said', () => {
  it('says the read did not arrive when the request never got there', () => {
    expect(describeFailure(new EnvioError('network', 'timed out'), ko)).toBe(ko.common.fetchFailed);
  });

  const down: readonly EnvioErrorKind[] = ['http', 'graphql', 'empty'];
  for (const kind of down) {
    it(`says the information is not available right now for \`${kind}\``, () => {
      expect(describeFailure(new EnvioError(kind, kind.toUpperCase()), ko)).toBe(ko.common.serviceDown);
    });
  }

  /**
   * The one that would break if the check were `instanceof`: every screen test in this app
   * mocks `shared/envio/client`, so the rejection under test is shaped like an `EnvioError`
   * without being one. Reading `name` and `kind` off the object is what keeps those tests
   * honest about what the screen will really show.
   */
  it('reads a rejection that is merely shaped like one, which is what a mocked module throws', () => {
    expect(describeFailure({ name: 'EnvioError', kind: 'network' }, ko)).toBe(ko.common.fetchFailed);
    expect(describeFailure({ name: 'EnvioError', kind: 'graphql' }, ko)).toBe(ko.common.serviceDown);
  });

  it('ignores a `kind` on something that is not an indexer failure at all', () => {
    expect(describeFailure({ name: 'Error', kind: 'network' }, ko)).toBe(ko.common.error);
    expect(describeFailure({ name: 'EnvioError', kind: 404 }, ko)).toBe(ko.common.error);
    // A kind nobody has added a sentence for is not silently the indexer's fault either.
    expect(describeFailure({ name: 'EnvioError', kind: 'teapot' }, ko)).toBe(ko.common.error);
  });
});

describe('step 4 · the reasons the caller named', () => {
  it('takes the sentence out of the table the screen handed in', () => {
    expect(describeFailure(new CallableError('resource-exhausted', 'ORG_LIMIT'), ko, TABLE))
      .toBe(TABLE.ORG_LIMIT);
  });

  it('falls through for a reason the table does not name', () => {
    expect(describeFailure(new CallableError('internal', 'CREATE_ORG_REVERTED'), ko, TABLE))
      .toBe(ko.common.error);
  });

  it('falls through when the screen handed in no table at all', () => {
    expect(describeFailure(new CallableError('failed-precondition', 'NOT_ACTIVE'), ko))
      .toBe(ko.common.error);
  });

  /** A reason that names something on `Object.prototype` is not a sentence anybody wrote. */
  it('reads only the table’s own keys', () => {
    expect(describeFailure(new CallableError('internal', 'toString'), ko, TABLE)).toBe(ko.common.error);
  });
});

describe('step 5 · everything else', () => {
  it('keeps the general line for a plain error', () => {
    expect(describeFailure(new Error('Failed to fetch'), ko)).toBe(ko.common.error);
  });

  it('keeps it for nothing at all', () => {
    expect(describeFailure(undefined, ko)).toBe(ko.common.error);
    expect(describeFailure(null, ko)).toBe(ko.common.error);
    expect(describeFailure('BOOM', ko)).toBe(ko.common.error);
  });
});

/** The sentence comes from the copy handed in, so an English reader gets English. */
describe('the locale is the caller’s', () => {
  it('answers in the copy it was given', () => {
    expect(describeFailure(new EnvioError('http', 'HTTP_500', 500), en)).toBe(en.common.serviceDown);
    expect(whileOffline(() => describeFailure(undefined, en))).toBe(en.common.offlineRetry);
    expect(en.common.serviceDown).not.toBe(ko.common.serviceDown);
  });
});
