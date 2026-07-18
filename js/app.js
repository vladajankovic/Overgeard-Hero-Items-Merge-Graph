(() => {
  'use strict';

  const canvas = document.querySelector('#graph-canvas');
  const ctx = canvas.getContext('2d');
  const wrap = document.querySelector('#graph-wrap');
  const statusEl = document.querySelector('#status');
  const tooltip = document.querySelector('#tooltip');
  const details = document.querySelector('#details');
  const detailsContent = document.querySelector('#details-content');
  const search = document.querySelector('#search');
  const searchResults = document.querySelector('#search-results');
  const sectionFilter = document.querySelector('#section-filter');
  const fallback = document.querySelector('#file-fallback');
  const sourceFile = document.querySelector('#source-file');

  const CARD_W = 172;
  const CARD_H = 72;
  const state = {
    nodes: [], edges: [], nodeById: new Map(), adjacency: new Map(),
    viewport: { x: 0, y: 0, scale: 1 },
    selected: null, hovered: null, visibleSections: new Set(),
    hoverFocus: null, highlightMix: 0, highlightAnimation: null,
    dragging: false, moved: false, pointerStart: null, viewportStart: null,
    pointers: new Map(), pinch: null,
    dpr: 1, images: new Map(), animation: null
  };

  const rarityColors = {
    common: '#b9c7c0', uncommon: '#79db8c', rare: '#55a9ff',
    epic: '#c187ff', legendary: '#ffba4b', unique: '#ff6f65', mythic: '#ff6f65'
  };

  function normalizeName(value) {
    return value.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();
  }

  function textFromCell(cell) {
    if (!cell) return '';
    const clone = cell.cloneNode(true);
    clone.querySelectorAll('img').forEach(img => {
      const label = (img.alt || '').replace(/-Description$/i, '').replace(/_/g, ' ');
      img.replaceWith(document.createTextNode(label ? ` ${label} ` : ''));
    });
    clone.querySelectorAll('br').forEach(br => br.replaceWith(document.createTextNode('\n')));
    return clone.textContent
      .replace(/[ \t]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function richHtmlFromCell(cell) {
    if (!cell) return '';
    const container = document.createElement('span');
    const copy = (source, target) => {
      source.childNodes.forEach(child => {
        if (child.nodeType === Node.TEXT_NODE) {
          target.append(document.createTextNode(child.textContent));
        } else if (child.nodeName === 'BR') {
          target.append(document.createElement('br'));
        } else if (child.nodeName === 'IMG') {
          const src = child.getAttribute('data-src') || child.getAttribute('src');
          if (!src) return;
          const label = (child.getAttribute('alt') || '').replace(/-Description$/i, '').replace(/_/g, ' ');
          const image = document.createElement('img');
          image.className = 'inline-stat-icon';
          image.src = src;
          image.alt = label;
          image.title = label;
          image.loading = 'lazy';
          target.append(image);
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          copy(child, target);
        }
      });
    };
    copy(cell, container);
    return container.innerHTML.trim();
  }

  function parseFootprint(cell) {
    if (!cell) return [];
    const rows = [[]];
    [...cell.childNodes].forEach(child => {
      if (child.nodeName === 'BR') rows.push([]);
      if (child.nodeType === Node.ELEMENT_NODE) {
        const squares = child.matches('[class*="grid-"]') ? [child] : [...child.querySelectorAll('[class*="grid-"]')];
        squares.forEach(square => {
          if (square.classList.contains('grid-filled')) rows.at(-1).push('filled');
          else if (square.classList.contains('grid-socket')) rows.at(-1).push('socket');
          else if (square.classList.contains('grid-empty')) rows.at(-1).push('empty');
        });
      }
    });
    return rows.filter(row => row.length);
  }

  function itemNamesFromCell(cell) {
    if (!cell) return [];
    return [...cell.querySelectorAll('img')]
      .map(img => (img.alt || '').replace(/\.png$/i, '').trim())
      .filter(Boolean);
  }

  function parseTable(source) {
    const doc = new DOMParser().parseFromString(source, 'text/html');
    const tables = [...doc.querySelectorAll('table.item-table')];
    if (!tables.length) throw new Error('No item tables were found in the selected HTML file.');

    const tabNames = [...doc.querySelectorAll('.wds-tabs__tab[data-hash]')]
      .map(tab => tab.dataset.hash.trim())
      .filter((value, index, all) => value && all.indexOf(value) === index);
    const defaultSections = ['Universal', 'Warrior', 'Ranger', 'Wizard', 'Pet'];
    const nodes = [];

    tables.forEach((table, tableIndex) => {
      const section = tabNames[tableIndex] || defaultSections[tableIndex] || `Table ${tableIndex + 1}`;
      if (section === 'Pet') return;
      const headers = [...table.querySelectorAll('thead th')].map(th => textFromCell(th).toLowerCase());
      const column = label => headers.findIndex(header => header.includes(label));
      const indexes = {
        sprite: column('sprite'), name: column('name'), type: column('type'), stats: column('stats'),
        effect: column('effect'), footprint: column('footprint'), recipes: column('merge recipes'), components: column('components')
      };

      table.querySelectorAll('tbody > tr').forEach((row, rowIndex) => {
        const cells = [...row.children].filter(el => el.tagName === 'TD');
        if (!cells.length) return;
        const name = textFromCell(cells[indexes.name]);
        if (!name) return;
        const spriteImg = cells[indexes.sprite]?.querySelector('img');
        const rarityClass = [...(cells[indexes.name]?.querySelector('[class*="grade-"]')?.classList || [])]
          .find(value => value.startsWith('grade-'));
        nodes.push({
          id: `item-${tableIndex}-${rowIndex}`,
          name,
          key: normalizeName(name),
          section,
          type: textFromCell(cells[indexes.type]).replace(/\n/g, ' · '),
          stats: textFromCell(cells[indexes.stats]),
          statsHtml: richHtmlFromCell(cells[indexes.stats]),
          effect: textFromCell(cells[indexes.effect]),
          effectHtml: richHtmlFromCell(cells[indexes.effect]),
          footprint: parseFootprint(cells[indexes.footprint]),
          sprite: spriteImg?.getAttribute('data-src') || spriteImg?.getAttribute('src') || '',
          aliases: [
            spriteImg?.getAttribute('alt'),
            spriteImg?.getAttribute('data-image-name')?.replace(/\.png$/i, '')
          ].filter(Boolean),
          rarity: rarityClass?.replace('grade-', '') || 'common',
          recipeNames: itemNamesFromCell(cells[indexes.recipes]),
          componentNames: itemNamesFromCell(cells[indexes.components]),
          x: 0, y: 0, level: 0, visible: true
        });
      });
    });

    const byName = new Map();
    nodes.forEach(node => {
      const keys = new Set([node.name, ...node.aliases].map(normalizeName));
      keys.forEach(key => {
        if (!byName.has(key)) byName.set(key, []);
        byName.get(key).push(node);
      });
    });
    const resolve = (name, section) => {
      const candidates = byName.get(normalizeName(name)) || [];
      return candidates.find(node => node.section === section)
        || candidates.find(node => node.section === 'Universal')
        || candidates[0];
    };

    const edgeMap = new Map();
    const addEdge = (sourceNode, targetNode, evidence) => {
      if (!sourceNode || !targetNode || sourceNode.id === targetNode.id) return;
      const key = `${sourceNode.id}>${targetNode.id}`;
      if (!edgeMap.has(key)) edgeMap.set(key, { id: key, source: sourceNode.id, target: targetNode.id, evidence: new Set() });
      edgeMap.get(key).evidence.add(evidence);
    };
    nodes.forEach(node => {
      node.recipeNames.forEach(name => addEdge(node, resolve(name, node.section), 'recipe'));
      node.componentNames.forEach(name => addEdge(resolve(name, node.section), node, 'component'));
    });
    const edges = [...edgeMap.values()].map(edge => ({ ...edge, evidence: [...edge.evidence] }));
    return { nodes, edges };
  }

  function buildGraph(parsed) {
    state.nodes = parsed.nodes;
    state.edges = parsed.edges;
    state.nodeById = new Map(state.nodes.map(node => [node.id, node]));
    state.adjacency = new Map(state.nodes.map(node => [node.id, new Set()]));
    state.edges.forEach(edge => {
      state.adjacency.get(edge.source)?.add(edge.target);
      state.adjacency.get(edge.target)?.add(edge.source);
    });
    state.visibleSections = new Set(state.nodes.map(node => node.section));
    populateFilters();
    applySectionFilter(false);
    preloadImages();
    resize();
    fitNodes(visibleNodes(), false);
  }

  function layoutGraph(nodes = state.nodes) {
    const nodeIds = new Set(nodes.map(node => node.id));
    nodes.forEach(node => { node.level = 0; node.order = 0; });
    const incoming = new Map(nodes.map(node => [node.id, []]));
    const outgoing = new Map(nodes.map(node => [node.id, []]));
    state.edges.filter(edge => nodeIds.has(edge.source) && nodeIds.has(edge.target)).forEach(edge => {
      incoming.get(edge.target)?.push(edge.source);
      outgoing.get(edge.source)?.push(edge.target);
    });
    const indegree = new Map(nodes.map(node => [node.id, incoming.get(node.id).length]));
    const queue = nodes.filter(node => indegree.get(node.id) === 0 && outgoing.get(node.id).length);
    queue.sort((a, b) => a.name.localeCompare(b.name));
    const visited = new Set();
    while (queue.length) {
      const node = queue.shift();
      visited.add(node.id);
      outgoing.get(node.id).forEach(targetId => {
        const target = state.nodeById.get(targetId);
        target.level = Math.max(target.level, node.level + 1);
        indegree.set(targetId, indegree.get(targetId) - 1);
        if (indegree.get(targetId) === 0) queue.push(target);
      });
    }
    nodes.filter(node => !visited.has(node.id) && (incoming.get(node.id).length || outgoing.get(node.id).length)).forEach(node => {
      node.level = Math.max(0, ...incoming.get(node.id).map(id => state.nodeById.get(id).level + 1));
    });

    const connected = nodes.filter(node => incoming.get(node.id).length || outgoing.get(node.id).length);
    const isolated = nodes.filter(node => !incoming.get(node.id).length && !outgoing.get(node.id).length);
    const layers = new Map();
    connected.forEach(node => {
      if (!layers.has(node.level)) layers.set(node.level, []);
      layers.get(node.level).push(node);
    });
    layers.forEach(layer => layer.sort((a, b) => a.section.localeCompare(b.section) || a.name.localeCompare(b.name)));

    // A few barycentric sweeps reduce crossings while fixed slots guarantee no overlap.
    for (let pass = 0; pass < 5; pass++) {
      [...layers.keys()].sort((a, b) => a - b).forEach(level => {
        const layer = layers.get(level);
        layer.sort((a, b) => neighborCenter(a, incoming, layers) - neighborCenter(b, incoming, layers) || a.name.localeCompare(b.name));
        layer.forEach((node, index) => { node.order = index; });
      });
    }

    const rowGap = 98;
    const columnGap = 255;
    const tallest = Math.max(1, ...[...layers.values()].map(layer => layer.length));
    layers.forEach((layer, level) => {
      const offset = (tallest - layer.length) * rowGap / 2;
      layer.forEach((node, index) => {
        node.x = level * columnGap;
        node.y = offset + index * rowGap;
      });
    });

    const maxLevel = Math.max(0, ...layers.keys());
    const isolateColumns = Math.max(5, Math.min(10, Math.ceil(Math.sqrt(isolated.length || 1))));
    const isolateTop = tallest * rowGap + 170;
    isolated.sort((a, b) => a.section.localeCompare(b.section) || a.name.localeCompare(b.name));
    isolated.forEach((node, index) => {
      node.x = (index % isolateColumns) * (CARD_W + 28);
      node.y = isolateTop + Math.floor(index / isolateColumns) * (CARD_H + 24);
      node.level = maxLevel + 2;
    });
  }

  function neighborCenter(node, incoming, layers) {
    const neighbors = incoming.get(node.id) || [];
    if (!neighbors.length) return node.order ?? 0;
    const positions = neighbors.map(id => state.nodeById.get(id)?.order).filter(Number.isFinite);
    return positions.length ? positions.reduce((sum, value) => sum + value, 0) / positions.length : node.order ?? 0;
  }

  function populateFilters() {
    sectionFilter.innerHTML = '';
    [...new Set(state.nodes.map(node => node.section))]
      .filter(section => section !== 'Universal')
      .forEach(section => {
        const option = document.createElement('option');
        option.value = section;
        option.textContent = section;
        sectionFilter.append(option);
      });
    const allOption = document.createElement('option');
    allOption.value = 'all';
    allOption.textContent = 'Universal + All';
    sectionFilter.append(allOption);
    sectionFilter.value = [...sectionFilter.options].some(option => option.value === 'Warrior') ? 'Warrior' : sectionFilter.options[0]?.value;
  }

  function applySectionFilter(animate = true) {
    const value = sectionFilter.value;
    state.nodes.forEach(node => {
      node.visible = value === 'all' || node.section === 'Universal' || node.section === value;
    });
    if (state.selected && !state.nodeById.get(state.selected)?.visible) selectNode(null, false);
    const filteredNodes = visibleNodes();
    layoutGraph(filteredNodes);
    statusEl.textContent = `${filteredNodes.length} of ${state.nodes.length} items · ${value === 'all' ? 'all classes' : value}`;
    if (animate) fitNodes(filteredNodes, true);
    render();
  }

  function preloadImages() {
    state.nodes.forEach(node => {
      if (!node.sprite || state.images.has(node.sprite)) return;
      const img = new Image();
      img.decoding = 'async';
      img.onload = render;
      img.onerror = render;
      img.src = node.sprite;
      state.images.set(node.sprite, img);
    });
  }

  function resize() {
    const rect = wrap.getBoundingClientRect();
    state.dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(rect.width * state.dpr));
    canvas.height = Math.max(1, Math.round(rect.height * state.dpr));
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    render();
  }

  function visibleNodes() { return state.nodes.filter(node => node.visible); }

  function render() {
    const width = canvas.width / state.dpr;
    const height = canvas.height / state.dpr;
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    drawBackdrop(width, height);
    ctx.save();
    ctx.translate(state.viewport.x, state.viewport.y);
    ctx.scale(state.viewport.scale, state.viewport.scale);

    const active = activeSet();
    state.edges.forEach(edge => drawEdge(edge, active));
    state.nodes.forEach(node => { if (node.visible) drawNode(node, active); });
    ctx.restore();
  }

  function drawBackdrop(width, height) {
    ctx.fillStyle = '#07120f';
    ctx.fillRect(0, 0, width, height);
    const spacing = 34 * state.viewport.scale;
    if (spacing < 10) return;
    const ox = ((state.viewport.x % spacing) + spacing) % spacing;
    const oy = ((state.viewport.y % spacing) + spacing) % spacing;
    ctx.fillStyle = 'rgba(123, 170, 150, .10)';
    for (let x = ox; x < width; x += spacing) {
      for (let y = oy; y < height; y += spacing) {
        ctx.beginPath(); ctx.arc(x, y, .75, 0, Math.PI * 2); ctx.fill();
      }
    }
  }

  function activeSet() {
    const focusId = state.selected || state.hoverFocus;
    if (!focusId) return null;
    return new Set([focusId, ...(state.adjacency.get(focusId) || [])]);
  }

  function highlightStrength() {
    return state.selected ? 1 : state.highlightMix;
  }

  function setHovered(id) {
    if (id === state.hovered) return;
    state.hovered = id;
    if (id) state.hoverFocus = id;
    animateHighlight(id ? 1 : 0, !id);
  }

  function animateHighlight(target, clearWhenDone = false) {
    if (state.highlightAnimation) cancelAnimationFrame(state.highlightAnimation);
    const start = state.highlightMix;
    const startedAt = performance.now();
    const duration = 220;
    const tick = now => {
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = progress < .5
        ? 2 * progress * progress
        : 1 - Math.pow(-2 * progress + 2, 2) / 2;
      state.highlightMix = start + (target - start) * eased;
      render();
      if (progress < 1) state.highlightAnimation = requestAnimationFrame(tick);
      else {
        state.highlightAnimation = null;
        if (clearWhenDone && !state.hovered) state.hoverFocus = null;
      }
    };
    state.highlightAnimation = requestAnimationFrame(tick);
  }

  function drawEdge(edge, active) {
    const source = state.nodeById.get(edge.source);
    const target = state.nodeById.get(edge.target);
    if (!source?.visible || !target?.visible) return;
    const highlighted = active?.has(source.id) && active?.has(target.id)
      && (source.id === state.selected || target.id === state.selected || source.id === state.hoverFocus || target.id === state.hoverFocus);
    const dimmed = active && !highlighted;
    const emphasis = highlightStrength();
    const start = clipToCard(source, target);
    const end = clipToCard(target, source);
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const bend = Math.min(55, Math.abs(dx) * .14) * Math.sign(dy || 1);
    const c1 = { x: start.x + dx * .42, y: start.y + bend };
    const c2 = { x: start.x + dx * .58, y: end.y + bend };
    ctx.save();
    ctx.globalAlpha = dimmed ? .34 - (.20 * emphasis) : highlighted ? .34 + (.66 * emphasis) : .34;
    ctx.strokeStyle = highlighted ? '#c6ff45' : '#5a8275';
    ctx.lineWidth = (highlighted ? 2.4 : 1.1) / state.viewport.scale ** .18;
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, end.x, end.y);
    ctx.stroke();
    const angle = Math.atan2(end.y - c2.y, end.x - c2.x);
    const arrow = highlighted ? 9 : 7;
    ctx.fillStyle = ctx.strokeStyle;
    ctx.beginPath();
    ctx.moveTo(end.x, end.y);
    ctx.lineTo(end.x - Math.cos(angle - .48) * arrow, end.y - Math.sin(angle - .48) * arrow);
    ctx.lineTo(end.x - Math.cos(angle + .48) * arrow, end.y - Math.sin(angle + .48) * arrow);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function clipToCard(from, to) {
    const fx = from.x + CARD_W / 2;
    const fy = from.y + CARD_H / 2;
    const tx = to.x + CARD_W / 2;
    const ty = to.y + CARD_H / 2;
    const dx = tx - fx;
    const dy = ty - fy;
    const scale = 1 / Math.max(Math.abs(dx) / (CARD_W / 2), Math.abs(dy) / (CARD_H / 2), .001);
    return { x: fx + dx * scale, y: fy + dy * scale };
  }

  function roundedRect(x, y, width, height, radius) {
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, radius);
  }

  function drawNode(node, active) {
    const chosen = node.id === state.selected;
    const hovered = node.id === state.hovered;
    const dimmed = active && !active.has(node.id);
    const emphasis = highlightStrength();
    ctx.save();
    ctx.globalAlpha = dimmed ? 1 - (.64 * emphasis) : 1;
    if (chosen || hovered) {
      ctx.shadowColor = chosen ? 'rgba(198,255,69,.48)' : 'rgba(100,230,207,.34)';
      ctx.shadowBlur = 18;
    }
    roundedRect(node.x, node.y, CARD_W, CARD_H, 10);
    ctx.fillStyle = chosen ? '#1b3d2a' : hovered ? '#1b4038' : '#142b25';
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = chosen ? 2 : 1;
    ctx.strokeStyle = chosen ? '#c6ff45' : hovered ? '#64e6cf' : 'rgba(128,170,153,.38)';
    ctx.stroke();

    ctx.fillStyle = rarityColors[node.rarity] || rarityColors.common;
    roundedRect(node.x, node.y, 4, CARD_H, 4);
    ctx.fill();

    ctx.fillStyle = 'rgba(255,255,255,.035)';
    roundedRect(node.x + 11, node.y + 11, 50, 50, 8);
    ctx.fill();
    const image = state.images.get(node.sprite);
    if (image?.complete && image.naturalWidth) {
      const ratio = Math.min(42 / image.naturalWidth, 42 / image.naturalHeight);
      const width = image.naturalWidth * ratio;
      const height = image.naturalHeight * ratio;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(image, node.x + 36 - width / 2, node.y + 36 - height / 2, width, height);
    } else {
      ctx.fillStyle = '#789087';
      ctx.font = '700 14px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText(node.name.slice(0, 1), node.x + 36, node.y + 41);
    }

    ctx.textAlign = 'left';
    ctx.fillStyle = '#edf7e7';
    ctx.font = '700 12px system-ui';
    ctx.fillText(ellipsize(node.name, 17), node.x + 70, node.y + 28);
    ctx.fillStyle = '#8da69b';
    ctx.font = '10px system-ui';
    ctx.fillText(ellipsize(node.type || 'Item', 23), node.x + 70, node.y + 45);
    ctx.fillStyle = rarityColors[node.rarity] || rarityColors.common;
    ctx.font = '800 8px system-ui';
    ctx.fillText(node.section.toUpperCase(), node.x + 70, node.y + 59);
    ctx.restore();
  }

  function ellipsize(value, max) { return value.length > max ? `${value.slice(0, max - 1)}…` : value; }

  function screenToWorld(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left - state.viewport.x) / state.viewport.scale,
      y: (clientY - rect.top - state.viewport.y) / state.viewport.scale
    };
  }

  function nodeAt(clientX, clientY) {
    const point = screenToWorld(clientX, clientY);
    for (let index = state.nodes.length - 1; index >= 0; index--) {
      const node = state.nodes[index];
      if (node.visible && point.x >= node.x && point.x <= node.x + CARD_W && point.y >= node.y && point.y <= node.y + CARD_H) return node;
    }
    return null;
  }

  function selectNode(node, focus = true) {
    state.selected = node?.id || null;
    setHovered(null);
    tooltip.hidden = true;
    updateDetails(node);
    if (node && focus) {
      const neighbors = [...(state.adjacency.get(node.id) || [])].map(id => state.nodeById.get(id)).filter(item => item?.visible);
      fitNodes([node, ...neighbors], true, true);
    }
    render();
  }

  function updateDetails(node) {
    details.classList.toggle('empty', !node);
    details.classList.remove('hidden');
    if (!node) {
      detailsContent.innerHTML = '<div class="empty-state"><span class="empty-glyph">⌁</span><h2>Select an item</h2><p>Its ingredients and creations will come into focus.</p></div>';
      return;
    }
    const incoming = state.edges.filter(edge => edge.target === node.id).map(edge => state.nodeById.get(edge.source));
    const outgoing = state.edges.filter(edge => edge.source === node.id).map(edge => state.nodeById.get(edge.target));
    detailsContent.innerHTML = `
      <div class="detail-hero">
        <div class="detail-sprite">${node.sprite ? `<img src="${escapeAttr(node.sprite)}" alt="">` : ''}</div>
        <div><p class="detail-kicker">${escapeHtml(node.section)} · ${escapeHtml(node.rarity)}</p><h2>${escapeHtml(node.name)}</h2><p class="detail-type">${escapeHtml(node.type || 'Item')}</p></div>
      </div>
      ${detailBlock('Stats', node.stats, node.statsHtml)}
      ${detailBlock('Effect', node.effect || 'No effect listed.', node.effectHtml)}
      ${node.footprint.length ? `<section class="detail-section"><h3>Footprint</h3>${footprintHtml(node.footprint)}</section>` : ''}
      ${relationBlock('Made from', incoming)}
      ${relationBlock('Creates', outgoing)}
    `;
    detailsContent.querySelectorAll('[data-node-id]').forEach(button => {
      button.addEventListener('click', () => selectNode(state.nodeById.get(button.dataset.nodeId)));
    });
  }

  function detailBlock(title, value, richHtml = '') {
    return value ? `<section class="detail-section"><h3>${title}</h3><div class="rich-text">${richHtml || escapeHtml(value)}</div></section>` : '';
  }

  function footprintHtml(rows) {
    const columns = Math.max(...rows.map(row => row.length));
    const cells = rows.flatMap(row => {
      const padded = [...row, ...Array(columns - row.length).fill('empty')];
      return padded.map(type => `<span class="footprint-cell ${type}" aria-hidden="true"></span>`);
    }).join('');
    const description = rows.map(row => row.map(type => type === 'filled' ? 'filled' : type === 'socket' ? 'socket' : 'blank').join(', ')).join('; ');
    return `<div class="footprint-grid" style="--footprint-columns:${columns}" role="img" aria-label="Item footprint: ${escapeAttr(description)}">${cells}</div>`;
  }

  function relationBlock(title, nodes) {
    const unique = [...new Map(nodes.filter(Boolean).map(node => [node.id, node])).values()];
    if (!unique.length) return '';
    return `<section class="detail-section"><h3>${title}</h3><div class="relations">${unique.map(node => `<button class="relation-chip" data-node-id="${node.id}">${escapeHtml(node.name)}</button>`).join('')}</div></section>`;
  }

  function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value || '';
    return div.innerHTML;
  }

  function escapeAttr(value) { return escapeHtml(value).replace(/"/g, '&quot;'); }

  function fitNodes(nodes, animate = true, accountForPanel = false) {
    const candidates = nodes.filter(node => node?.visible);
    if (!candidates.length) return;
    const rect = canvas.getBoundingClientRect();
    const panelSpace = accountForPanel && rect.width > 760 ? 400 : 0;
    const pad = candidates.length === 1 ? 170 : 80;
    const minX = Math.min(...candidates.map(node => node.x));
    const minY = Math.min(...candidates.map(node => node.y));
    const maxX = Math.max(...candidates.map(node => node.x + CARD_W));
    const maxY = Math.max(...candidates.map(node => node.y + CARD_H));
    const availableWidth = Math.max(250, rect.width - panelSpace);
    const scale = Math.max(.16, Math.min(1.65, Math.min((availableWidth - pad * 2) / Math.max(CARD_W, maxX - minX), (rect.height - pad * 2) / Math.max(CARD_H, maxY - minY))));
    const target = {
      scale,
      x: (availableWidth - (maxX - minX) * scale) / 2 - minX * scale,
      y: (rect.height - (maxY - minY) * scale) / 2 - minY * scale
    };
    setViewport(target, animate);
  }

  function setViewport(target, animate) {
    if (!animate) { Object.assign(state.viewport, target); render(); return; }
    if (state.animation) cancelAnimationFrame(state.animation);
    const start = { ...state.viewport };
    const startTime = performance.now();
    const tick = now => {
      const progress = Math.min(1, (now - startTime) / 420);
      const eased = 1 - Math.pow(1 - progress, 3);
      state.viewport.x = start.x + (target.x - start.x) * eased;
      state.viewport.y = start.y + (target.y - start.y) * eased;
      state.viewport.scale = start.scale + (target.scale - start.scale) * eased;
      render();
      if (progress < 1) state.animation = requestAnimationFrame(tick);
    };
    state.animation = requestAnimationFrame(tick);
  }

  function showTooltip(node, clientX, clientY) {
    if (!node) { tooltip.hidden = true; return; }
    const tooltipStats = node.statsHtml || escapeHtml(node.stats || node.type || 'Item');
    tooltip.innerHTML = `<strong>${escapeHtml(node.name)}</strong><span class="tooltip-rich">${tooltipStats}</span>`;
    tooltip.hidden = false;
    const wrapRect = wrap.getBoundingClientRect();
    const x = Math.min(wrapRect.width - 275, clientX - wrapRect.left + 15);
    const y = Math.min(wrapRect.height - tooltip.offsetHeight - 12, clientY - wrapRect.top + 15);
    tooltip.style.left = `${Math.max(10, x)}px`;
    tooltip.style.top = `${Math.max(10, y)}px`;
  }

  function zoomAt(screenX, screenY, factor) {
    const oldScale = state.viewport.scale;
    const nextScale = Math.max(.12, Math.min(2.6, oldScale * factor));
    const worldX = (screenX - state.viewport.x) / oldScale;
    const worldY = (screenY - state.viewport.y) / oldScale;
    state.viewport.scale = nextScale;
    state.viewport.x = screenX - worldX * nextScale;
    state.viewport.y = screenY - worldY * nextScale;
    render();
  }

  function pointerDistance(points) {
    return Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
  }

  function pointerCenter(points) {
    return { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
  }

  canvas.addEventListener('pointerdown', event => {
    canvas.setPointerCapture(event.pointerId);
    state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (state.pointers.size === 2) {
      const points = [...state.pointers.values()];
      const center = pointerCenter(points);
      const rect = canvas.getBoundingClientRect();
      const screenCenter = { x: center.x - rect.left, y: center.y - rect.top };
      state.pinch = {
        distance: pointerDistance(points),
        scale: state.viewport.scale,
        worldX: (screenCenter.x - state.viewport.x) / state.viewport.scale,
        worldY: (screenCenter.y - state.viewport.y) / state.viewport.scale
      };
      state.moved = true;
      tooltip.hidden = true;
      return;
    }
    state.dragging = true;
    state.moved = false;
    state.pointerStart = { x: event.clientX, y: event.clientY };
    state.viewportStart = { x: state.viewport.x, y: state.viewport.y };
    canvas.classList.add('dragging');
    canvas.style.cursor = 'grabbing';
    setHovered(null);
    tooltip.hidden = true;
  });

  canvas.addEventListener('pointermove', event => {
    if (state.pointers.has(event.pointerId)) state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (state.pinch && state.pointers.size >= 2) {
      const points = [...state.pointers.values()].slice(0, 2);
      const center = pointerCenter(points);
      const rect = canvas.getBoundingClientRect();
      const screenX = center.x - rect.left;
      const screenY = center.y - rect.top;
      state.viewport.scale = Math.max(.12, Math.min(2.6, state.pinch.scale * pointerDistance(points) / Math.max(1, state.pinch.distance)));
      state.viewport.x = screenX - state.pinch.worldX * state.viewport.scale;
      state.viewport.y = screenY - state.pinch.worldY * state.viewport.scale;
      render();
      return;
    }
    if (state.dragging) {
      const dx = event.clientX - state.pointerStart.x;
      const dy = event.clientY - state.pointerStart.y;
      if (Math.hypot(dx, dy) > 3) state.moved = true;
      state.viewport.x = state.viewportStart.x + dx;
      state.viewport.y = state.viewportStart.y + dy;
      render();
      return;
    }
    const node = nodeAt(event.clientX, event.clientY);
    const id = node?.id || null;
    setHovered(id);
    canvas.style.cursor = node ? 'pointer' : 'grab';
    showTooltip(node, event.clientX, event.clientY);
  });

  canvas.addEventListener('pointerup', event => {
    const wasPinching = Boolean(state.pinch);
    state.pointers.delete(event.pointerId);
    if (wasPinching) {
      state.pinch = null;
      state.moved = true;
      if (state.pointers.size === 1) {
        const remaining = [...state.pointers.values()][0];
        state.dragging = true;
        state.pointerStart = { ...remaining };
        state.viewportStart = { x: state.viewport.x, y: state.viewport.y };
      } else {
        state.dragging = false;
        canvas.classList.remove('dragging');
        canvas.style.cursor = 'grab';
      }
      return;
    }
    if (!state.dragging) return;
    state.dragging = false;
    canvas.classList.remove('dragging');
    canvas.style.cursor = nodeAt(event.clientX, event.clientY) ? 'pointer' : 'grab';
    if (!state.moved) selectNode(nodeAt(event.clientX, event.clientY));
  });
  canvas.addEventListener('pointercancel', event => {
    state.pointers.delete(event.pointerId);
    state.pinch = null;
    state.dragging = false;
    state.moved = false;
    canvas.classList.remove('dragging');
    canvas.style.cursor = 'grab';
  });
  canvas.addEventListener('pointerleave', () => {
    if (!state.dragging) {
      setHovered(null);
      tooltip.hidden = true;
    }
  });

  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    if (!event.ctrlKey && !event.metaKey) {
      if (event.shiftKey && !event.deltaX) state.viewport.x -= event.deltaY;
      else {
        state.viewport.x -= event.deltaX;
        state.viewport.y -= event.deltaY;
      }
      tooltip.hidden = true;
      render();
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;
    const factor = Math.exp(-event.deltaY * .0014);
    zoomAt(mouseX, mouseY, factor);
  }, { passive: false });

  search.addEventListener('input', () => {
    const term = normalizeName(search.value);
    if (!term) { searchResults.hidden = true; return; }
    const matches = state.nodes.filter(node => node.visible && node.key.includes(term)).slice(0, 12);
    searchResults.innerHTML = matches.length ? matches.map(node => `
      <button class="search-result" data-node-id="${node.id}">
        ${node.sprite ? `<img src="${escapeAttr(node.sprite)}" alt="">` : '<span></span>'}
        <span><strong>${escapeHtml(node.name)}</strong><small>${escapeHtml(node.section)} · ${escapeHtml(node.type || 'Item')}</small></span>
      </button>`).join('') : '<div class="search-result"><small>No matching items</small></div>';
    searchResults.hidden = false;
    searchResults.querySelectorAll('[data-node-id]').forEach(button => button.addEventListener('click', () => {
      const node = state.nodeById.get(button.dataset.nodeId);
      search.value = node.name;
      searchResults.hidden = true;
      selectNode(node);
    }));
  });
  search.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      const first = searchResults.querySelector('[data-node-id]');
      if (first) { event.preventDefault(); first.click(); }
    }
    if (event.key === 'Escape') { search.value = ''; searchResults.hidden = true; search.blur(); }
  });
  document.addEventListener('pointerdown', event => {
    if (!event.target.closest('.search-control')) searchResults.hidden = true;
  });

  sectionFilter.addEventListener('change', () => applySectionFilter(true));

  document.querySelector('#zoom-in').addEventListener('click', () => zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, 1.22));
  document.querySelector('#zoom-out').addEventListener('click', () => zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, 1 / 1.22));
  document.querySelector('#fit-button').addEventListener('click', () => fitNodes(visibleNodes(), true));
  document.querySelector('#reset-button').addEventListener('click', () => selectNode(null, false));
  document.querySelector('#close-details').addEventListener('click', () => { selectNode(null, false); details.classList.add('hidden'); });
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && document.activeElement !== search) selectNode(null, false);
    if (event.key.toLowerCase() === 'f' && !['INPUT', 'SELECT'].includes(document.activeElement.tagName)) fitNodes(visibleNodes(), true);
  });
  window.addEventListener('resize', resize);

  sourceFile.addEventListener('change', async () => {
    const file = sourceFile.files[0];
    if (!file) return;
    try {
      buildGraph(parseTable(await file.text()));
      fallback.hidden = true;
    } catch (error) {
      statusEl.textContent = error.message;
    }
  });

  async function load() {
    try {
      const sourceUrl = new URL('./item_table.html', document.baseURI);
      const response = await fetch(sourceUrl, { cache: 'no-cache' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      buildGraph(parseTable(await response.text()));
    } catch (error) {
      statusEl.textContent = 'Source file access required';
      fallback.hidden = false;
      console.warn('Automatic source loading failed:', error);
    }
  }

  load();
})();
