import { describe, expect, it } from 'vitest'
import { salaryText, sourceLabel } from '../app/utils/posting'

describe('posting words', () => {
  it('keeps pence when the pay has them, never rounding the minimum up', () => {
    expect(salaryText({ min: 12.6, max: 13.5, currency: 'GBP' })).toBe('£12.60 – £13.50')
    expect(salaryText({ min: 28000, max: 32000, currency: 'GBP' })).toBe('£28,000 – £32,000')
    expect(salaryText({ min: 12.5, max: null, currency: null })).toBe('From 12.50')
  })
  it('names a source tag one way everywhere', () => {
    expect(sourceLabel('feed')).toBe('Job feed')
    expect(sourceLabel('import')).toBe('Imported from a spreadsheet')
    expect(sourceLabel('spring-fair')).toBe('Spring fair')
    expect(sourceLabel(null, 'No source tag')).toBe('No source tag')
  })
})
