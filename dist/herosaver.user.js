// ==UserScript==
// @name         Herosaver
// @namespace    https://github.com/PopleZoo/Herosaver
// @version      1.5.10
// @description  Save Configuration and STLs from websites using the THREE.JS framework
// @author       reformagus&D1amondweaver
// @homepageURL  https://github.com/PopleZoo/Herosaver
// @match        *://*.heroforge.com/*
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @downloadURL  https://cdn.jsdelivr.net/gh/PopleZoo/Herosaver@UVCoords/dist/herosaver.user.js
// @updateURL    https://cdn.jsdelivr.net/gh/PopleZoo/Herosaver@UVCoords/dist/herosaver.user.js
// ==/UserScript==

(function () {
  'use strict'

  // Load the bundle pinned to the current commit SHA. Branch CDN URLs (raw or
  // jsDelivr) cache for minutes and kept serving old bundles, so the loader
  // first asks the GitHub API for the latest commit, then fetches that
  // immutable SHA-pinned file. Always fresh, never stale.
  const run = (fn) => {
    const s = document.createElement('script')
    s.textContent = `(async()=>{const c=await fetch('https://api.github.com/repos/PopleZoo/Herosaver/commits/UVCoords').then(r=>r.json());const src='https://raw.githubusercontent.com/PopleZoo/Herosaver/'+c.sha+'/dist/herosaver.js';eval(await fetch(src).then(r=>r.text()));${fn}()})()`
    document.body.appendChild(s)
    s.remove()
  }

  // ─── Tampermonkey menu commands ───────────────────────────────────────────
  // "Save Clean STL" exports the model with the surrounding cube/shell automatically
  // removed (cube removal runs locally in the bundle, no external page needed).
  GM_registerMenuCommand('Herosaver: Save Clean STL', () => run('saveCleanStl'))
  GM_registerMenuCommand('Herosaver: Save OBJ and Textures', () => run('saveObj'))
  GM_registerMenuCommand('Herosaver: Save glTF (rigged)', () => run('saveGltf'))
  GM_registerMenuCommand('Herosaver: Save FBX (rigged)', () => run('saveFbx'))
  GM_registerMenuCommand('Herosaver: Save JSON', () => run('saveJson'))
  // ─── Remove any foreign "Save STL" button ─────────────────────────────────
  // Drop any other on-page control labelled exactly "Save STL" that this script
  // did not create (e.g. a leftover button from another tool), so only the
  // Herosaver panel button remains.
  function removeForeignSaveStlButtons () {
    const panel = document.getElementById('herosaver-panel')
    document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]').forEach(el => {
      if (panel && panel.contains(el)) return
      const label = (el.textContent || el.value || '').trim()
      if (label === 'Save STL') el.remove()
    })
  }

  // ─── On-page button panel ─────────────────────────────────────────────────
  // A small floating panel with the same actions, so they are reachable without
  // opening the userscript-manager menu.
  function injectPanel () {
    if (document.getElementById('herosaver-panel')) return

    const panel = document.createElement('div')
    panel.id = 'herosaver-panel'
    panel.style.cssText = [
      'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
      'display:flex', 'flex-direction:column', 'gap:6px',
      'padding:10px', 'border-radius:10px',
      'background:rgba(17,24,39,0.92)', 'box-shadow:0 4px 16px rgba(0,0,0,0.35)',
      'font-family:system-ui,-apple-system,sans-serif', 'font-size:13px'
    ].join(';')

    const title = document.createElement('div')
    title.textContent = 'Herosaver'
    title.style.cssText = 'color:#9ca3af;font-weight:600;font-size:11px;letter-spacing:.05em;text-transform:uppercase;margin-bottom:6px'
    panel.appendChild(title)

    const row = (children) => {
      const r = document.createElement('div')
      r.style.cssText = 'display:flex;align-items:center;gap:8px'
      children.forEach(c => r.appendChild(c))
      return r
    }

    // "Save as" format dropdown. Labels state what each format contains; the
    // rig is baked into glTF/FBX (always) and never into OBJ/STL.
    const select = document.createElement('select')
    select.style.cssText = 'width:100%;background:#374151;color:#fff;border:0;border-radius:6px;padding:8px 10px;font-size:13px;cursor:pointer'
    const formats = [
      ['stl', 'STL'],
      ['obj', 'OBJ+Textures'],
      ['gltf', 'glTF+Rigged+Textures'],
      ['fbx', 'FBX+Rigged+Textures']
    ]
    formats.forEach(([value, label]) => {
      const o = document.createElement('option')
      o.value = value
      o.textContent = label
      if (value === 'obj') o.selected = true
      select.appendChild(o)
    })
    panel.appendChild(row([select]))

    const makeBtn = (label, fn, primary) => {
      const b = document.createElement('button')
      b.textContent = label
      b.style.cssText = [
        'width:100%', 'cursor:pointer', 'border:0', 'border-radius:6px',
        'padding:8px 12px', 'font-size:13px', 'font-weight:600', 'text-align:center',
        primary ? 'background:#2563eb' : 'background:#374151', 'color:#fff'
      ].join(';')
      b.addEventListener('click', () => { if (fn) run(fn) })
      return b
    }

    const saveBtn = makeBtn('Save', '', true)
    saveBtn.addEventListener('click', () => {
      const state = {
        format: select.value,
        rigged: select.value === 'gltf' || select.value === 'fbx'
      }
      console.log('[Herosaver] Panel Save clicked, state:', state)
      window.__herosaverSaveState = state
      run('saveSelected')
    })
    panel.appendChild(saveBtn)

    // Save JSON stays separate from the export dropdown.
    panel.appendChild(makeBtn('Save JSON', 'saveJson', false))

    document.body.appendChild(panel)
  }

  function init () {
    injectPanel()
    // Sweep now and a few more times, since a foreign button may render late.
    removeForeignSaveStlButtons()
    ;[1000, 2500, 5000].forEach(ms => setTimeout(removeForeignSaveStlButtons, ms))
  }

  if (document.body) init()
  else window.addEventListener('DOMContentLoaded', init)
})()
