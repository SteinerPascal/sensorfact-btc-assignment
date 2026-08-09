import { config } from './config'

/**
 * Energy is derived at read time rather than stored, so the constant can change
 * without a data migration.
 */
export function energyKwh(sizeBytes: number | string): number {
  return Number(sizeBytes) * config.kwhPerByte
}
