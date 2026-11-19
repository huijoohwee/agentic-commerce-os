// Both pack hosts serve these same local modules and styles at their own route prefix.
export const filesWithExtension = (names: string, extension: string) => names.split(' ').map(name => name + '.' + extension)
export const packAssets = [
  ...filesWithExtension('markdown markdown-parser color panel-section workspace-layout dashboard-columns toolbar-icons commerce-toolbar dropdown-menus floating-panel', 'js'),
  ...filesWithExtension('rich-text panel-section commerce-shell graph-ui-tokens commerce-theme shared-ui-profile floating-panel skills-commands collection-layout toolbar', 'css'),
  'icons.json',
]
export const packEntries = ['workspace-pack.js', 'workspace-pack.simulation.js', 'workspace-pack.console.js', 'workspace-pack.css']
