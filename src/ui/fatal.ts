/** Replaces the loading screen with a message, so a failure never looks like endless loading. */
export function showFatal(text: string, reload: boolean) {
  const el = document.getElementById('loading');
  if (!el) return;
  el.classList.remove('gone');
  el.classList.add('failed');
  el.setAttribute('role', 'alert');
  const p = document.createElement('p');
  p.className = 'fatal';
  p.textContent = text;
  const nodes: HTMLElement[] = [p];
  if (reload) {
    const b = document.createElement('button');
    b.className = 'fatal-btn';
    b.textContent = 'Reload page';
    b.addEventListener('click', () => location.reload());
    nodes.push(b);
  }
  el.replaceChildren(...nodes);
}
