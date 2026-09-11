const node = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
};
const badge = value => { const tag = node('span', value, 'badge'); tag.dataset.status = value; return tag; };
const showView = (view, focus = false) => {
  const navigation = [...document.querySelectorAll('[data-view-link]')];
  if (!navigation.length) return;
  const selected = navigation.find(link => link.dataset.viewLink === view) || navigation[0];
  for (const link of navigation) {
    if (link === selected) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  }
  for (const panel of document.querySelectorAll('[data-views]')) panel.hidden = !panel.dataset.views.split(' ').includes(selected.dataset.viewLink);
  const heading = document.querySelector('#workspace-heading');
  heading.textContent = selected.dataset.title || selected.textContent;
  if (focus) heading.focus();
};
window.addEventListener('hashchange', () => showView(location.hash.slice(1), true));
showView(location.hash.slice(1));
for (const button of document.querySelectorAll('[data-close-dialog]')) button.addEventListener('click', () => button.closest('dialog').close());
const describe = (parent, fields) => {
  const list = node('dl');
  for (const [label, value] of fields) list.append(node('dt', label), node('dd', value));
  parent.append(list);
};
