/**
 * The plugin version, hardcoded on purpose: it rides the helper-process
 * protocol handshake, so it must track `package.json` — a bumped package
 * version without a matching bump here would report a stale helper.
 *
 * @module dsh-windows-remote-ssh/version
 */

/** Plugin version advertised in the helper-protocol handshake. */
export const VERSION = '0.1.0'

/** The helper wire-protocol revision; bump only on incompatible wire changes. */
export const HELPER_PROTOCOL_VERSION = 1
