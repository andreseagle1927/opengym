import React, { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { parseHTML } from 'linkedom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import BodyMap from './BodyMap.jsx'

let dom
let root
let container

function installDom() {
  dom = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>').window
  globalThis.window = dom
  globalThis.document = dom.document
  for (const key of ['HTMLElement', 'Node', 'Element', 'Event']) globalThis[key] = dom[key]
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.getElementById('root')
  root = createRoot(container)
}

function InteractiveMap() {
  const [selected, setSelected] = useState(['chest', 'biceps'])
  const toggle = muscle => setSelected(current => current.includes(muscle)
    ? current.filter(item => item !== muscle)
    : [...current, muscle])
  return <BodyMap selected={selected} load={{ chest: 1, biceps: 1 }} onMuscle={toggle} />
}

beforeEach(() => installDom())
afterEach(async () => {
  if (root) await act(async () => root.unmount())
  root = null
  delete globalThis.window
  delete globalThis.document
  for (const key of ['HTMLElement', 'Node', 'Element', 'Event', 'IS_REACT_ACT_ENVIRONMENT']) delete globalThis[key]
})

describe('BodyMap multi-selection', () => {
  it('highlights multiple selected muscles and toggles a selected muscle off by tapping the map', async () => {
    await act(async () => root.render(<InteractiveMap />))
    await act(async () => { await import('../lib/body-paths.js') })

    const chest = [...container.querySelectorAll('.bm-m')].find(path => path.querySelector('title')?.textContent === 'Chest')
    const biceps = [...container.querySelectorAll('.bm-m')].find(path => path.querySelector('title')?.textContent === 'Biceps')
    expect(chest?.classList.contains('sel')).toBe(true)
    expect(biceps?.classList.contains('sel')).toBe(true)
    await act(async () => chest.dispatchEvent(new dom.Event('click', { bubbles: true })))
    expect(chest.classList.contains('sel')).toBe(false)
    expect(biceps.classList.contains('sel')).toBe(true)
  })
})
