// The password lock as seen by the sync code (lib/syncseal.js wants {enabled, locked, writer, reader}).
import * as lockrt from './lockrt.js';

export const lockAdapter = {
  enabled: () => lockrt.enabled(),
  locked: () => lockrt.isLocked(),
  writer: () => lockrt.writer(),
  reader: () => lockrt.getReader(),
};
