import { describe, expect, it } from 'vitest'
import { parseCsv, splitName } from '../shared/csv'

describe('parseCsv', () => {
  it('handles quotes, escaped quotes, delimiters and newlines inside quotes, CRLF and a BOM', () => {
    const text = '﻿name,email,note\r\n"Doe, Jane",jane@x.test,"said ""hi""\r\nthen left"\r\nBob,bob@x.test,\r\n'
    expect(parseCsv(text)).toEqual([
      ['name', 'email', 'note'],
      ['Doe, Jane', 'jane@x.test', 'said "hi"\r\nthen left'],
      ['Bob', 'bob@x.test', ''],
    ])
  })

  it('sniffs ; and tab from the header line, ignoring quoted ones', () => {
    expect(parseCsv('a;b;"c,d"\n1;2,5;3')).toEqual([['a', 'b', 'c,d'], ['1', '2,5', '3']])
    expect(parseCsv('a\tb\n1\t2')).toEqual([['a', 'b'], ['1', '2']])
    expect(parseCsv('"x;y;z",b\n1,2')).toEqual([['x;y;z', 'b'], ['1', '2']])
  })

  it('keeps blank lines so record numbers match spreadsheet rows, no trailing empty record', () => {
    expect(parseCsv('a\n\nb\n')).toEqual([['a'], [''], ['b']])
    expect(parseCsv('')).toEqual([])
  })
})

describe('splitName', () => {
  it('last word is the last name', () => {
    expect(splitName('  Mary  Ann Smith ')).toEqual({ first: 'Mary Ann', last: 'Smith' })
    expect(splitName('Cher')).toEqual({ first: 'Cher', last: '' })
    expect(splitName('')).toEqual({ first: '', last: '' })
  })
})
