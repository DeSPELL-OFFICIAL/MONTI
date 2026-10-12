import { describe, expect, it } from 'vitest';
import { describeFailure } from './errors';
// The real class, not a mock: the point of the module is that it reads a rejection the
// indexer actually built, and the structural case below proves the mocked shape works too.
import { EnvioError, type EnvioErrorKind } from './envio/client';
import { CallableError } from './api/functions';
import { en } from './copy';

/** The table a screen hands in: the server's reasons that are worth a sentence of their own. */
const TABLE = { NOT_ACTIVE: 'Please finish signing up first', ORG_LIMIT: 'You can create up to three teams' };

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
    const said = whileOffline(() => describeFailure(new EnvioError('network', 'REQUEST_FAILED'), en));
    expect(said).toBe(en.common.offlineRetry);
    // The same rejection with the connection back says something else entirely — which is why
    // this step has to come first.
    expect(describeFailure(new EnvioError('network', 'REQUEST_FAILED'), en)).toBe(en.common.fetchFailed);
  });

  it('outranks an indexer that really did answer badly', () => {
    expect(whileOffline(() => describeFailure(new EnvioError('http', 'HTTP_503', 503), en)))
      .toBe(en.common.offlineRetry);
  });

  it('outranks a reason the caller named', () => {
    const failure = new CallableError('failed-precondition', 'NOT_ACTIVE');
    expect(whileOffline(() => describeFailure(failure, en, TABLE))).toBe(en.common.offlineRetry);
    expect(describeFailure(failure, en, TABLE)).toBe(TABLE.NOT_ACTIVE);
  });

  it('puts the real `onLine` back', () => {
    whileOffline(() => undefined);
    expect(navigator.onLine).toBe(true);
  });
});

describe('steps 2 and 3 · what the indexer said', () => {
  it('says the read did not arrive when the request never got there', () => {
    expect(describeFailure(new EnvioError('network', 'timed out'), en)).toBe(en.common.fetchFailed);
  });

  const down: readonly EnvioErrorKind[] = ['http', 'graphql', 'empty'];
  for (const kind of down) {
    it(`says the information is not available right now for \`${kind}\``, () => {
      expect(describeFailure(new EnvioError(kind, kind.toUpperCase()), en)).toBe(en.common.serviceDown);
    });
  }

  /**
   * The one that would break if the check were `instanceof`: every screen test in this app
   * mocks `shared/envio/client`, so the rejection under test is shaped like an `EnvioError`
   * without being one. Reading `name` and `kind` off the object is what keeps those tests
   * honest about what the screen will really show.
   */
  it('reads a rejection that is merely shaped like one, which is what a mocked module throws', () => {
    expect(describeFailure({ name: 'EnvioError', kind: 'network' }, en)).toBe(en.common.fetchFailed);
    expect(describeFailure({ name: 'EnvioError', kind: 'graphql' }, en)).toBe(en.common.serviceDown);
  });

  it('ignores a `kind` on something that is not an indexer failure at all', () => {
    expect(describeFailure({ name: 'Error', kind: 'network' }, en)).toBe(en.common.error);
    expect(describeFailure({ name: 'EnvioError', kind: 404 }, en)).toBe(en.common.error);
    // A kind nobody has added a sentence for is not silently the indexer's fault either.
    expect(describeFailure({ name: 'EnvioError', kind: 'teapot' }, en)).toBe(en.common.error);
  });
});

describe('step 4 · the reasons the caller named', () => {
  it('takes the sentence out of the table the screen handed in', () => {
    expect(describeFailure(new CallableError('resource-exhausted', 'ORG_LIMIT'), en, TABLE))
      .toBe(TABLE.ORG_LIMIT);
  });

  it('falls through for a reason the table does not name', () => {
    expect(describeFailure(new CallableError('internal', 'CREATE_ORG_REVERTED'), en, TABLE))
      .toBe(en.common.error);
  });

  it('falls through when the screen handed in no table at all', () => {
    expect(describeFailure(new CallableError('failed-precondition', 'NOT_ACTIVE'), en))
      .toBe(en.common.error);
  });

  /** A reason that names something on `Object.prototype` is not a sentence anybody wrote. */
  it('reads only the table’s own keys', () => {
    expect(describeFailure(new CallableError('internal', 'toString'), en, TABLE)).toBe(en.common.error);
  });
});

describe('step 5 · everything else', () => {
  it('keeps the general line for a plain error', () => {
    expect(describeFailure(new Error('Failed to fetch'), en)).toBe(en.common.error);
  });

  it('keeps it for nothing at all', () => {
    expect(describeFailure(undefined, en)).toBe(en.common.error);
    expect(describeFailure(null, en)).toBe(en.common.error);
    expect(describeFailure('BOOM', en)).toBe(en.common.error);
  });
});

/** The sentence comes from the copy handed in, so an English reader gets English. */
describe('the locale is the caller’s', () => {
  it('answers in the copy it was given', () => {
    expect(describeFailure(new EnvioError('http', 'HTTP_500', 500), en)).toBe(en.common.serviceDown);
    expect(whileOffline(() => describeFailure(undefined, en))).toBe(en.common.offlineRetry);
  });
});
