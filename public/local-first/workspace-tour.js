import { getOrCreateSingleton } from './workspace-singleton.js'

function initializeWorkspaceTour() {
  const tours = {
    shop: {
      label: 'Shopper workspace',
      steps: [
        ['One workspace, on this device.', 'Your saved drafts stay in this browser. Only reviewed offer details belong in the shopper view.'],
        ['Start with the sample offer.', 'The education materials offer is a fixed sandbox example with a clear price and its own checkout flow.'],
        ['Explore what is ready.', 'Completed offers appear here after launch review. Private drafts remain in the vendor workspace.'],
        ['Try checkout safely.', 'Use the sandbox flow to preview a purchase. It does not place a live order or collect real money.'],
        ['Keep private details private.', 'The storefront shows the offer title, outcome, audience and planned price. Internal notes stay in your workspace.']
      ]
    },
    vendor: {
      label: 'Vendor workspace',
      steps: [
        ['Build a clear offer.', 'Describe the buyer and the outcome in a private draft before preparing a launch pack.'],
        ['Add the launch terms.', 'Keep price, costs, timing and delivery details together so readiness can be reviewed.'],
        ['Preview the shopper view.', 'Check the title, outcome, audience and planned price. Private notes and cost estimates stay internal.'],
        ['Prepare for human review.', 'Check the current draft before export. Saving an offer does not publish it or connect a sales channel.']
      ]
    },
    admin: {
      label: 'Admin workspace',
      steps: [
        ['Your projects, in one view.', 'Projects group the offers saved on this device by merchant workspace.'],
        ['Review the exact offer.', 'Check saved terms and readiness signals before the required human launch review.'],
        ['Inspect current status.', 'Environment checks are time-bound observations. They do not publish offers or prove a deployment.'],
        ['Keep a portable copy.', 'Export a private backup or move selected drafts when you change browsers.']
      ]
    },
    sme: {
      label: 'SME business pack',
      steps: [
        ['Choose a country pack.', 'Select a provisional Singapore or Malaysia reference pack before entering business details.'],
        ['Use the closest available band.', 'Enter seller-reported categories. The form does not verify records or documents.'],
        ['Read the indicators carefully.', 'The report shows completeness and simple midpoint ratios. It is not a valuation.'],
        ['Keep inputs on this device.', 'Checks run locally, and facts entered in the form are not saved.']
      ]
    }
  }
  const intros = {
    shop: ['A local-first path from offer to storefront.', 'Explore a shopper view, while private drafts stay on this device.'],
    vendor: ['A local-first path from offer draft to review.', 'Prepare one offer at a time, keep private details on this device, and review before you share.'],
    admin: ['One view for projects and review.', 'Inspect the saved work on this device, then review the exact offer before an authorized next step.'],
    sme: ['Indicative business checks, on this device.', 'Choose a provisional country pack, enter reported facts, and review a simple completeness report.']
  }
  const dialog = document.querySelector('#workspace-tour')
  if (!(dialog instanceof HTMLDialogElement)) throw Error('workspace_tour_mount_missing')
  const $ = selector => dialog.querySelector(selector)
  let role, stepIndex, opener, introMode = false

  function renderStep() {
    const tour = tours[role], [title, copy] = introMode ? intros[role] : tour.steps[stepIndex]
    $('#tour-kicker').textContent = tour.label.toUpperCase()
    $('#tour-heading').textContent = title
    $('#tour-copy').textContent = copy
    const showOverview = introMode && ['shop', 'vendor'].includes(role)
    $('#tour-overview').hidden = !showOverview
    $('#tour-overview').setAttribute('aria-hidden', String(!showOverview))
    $('#tour-step').textContent = introMode ? 'A local-first workspace' : `Step ${stepIndex + 1} of ${tour.steps.length}`
    $('#tour-dots').replaceChildren(...tour.steps.map((_, index) => {
      const dot = document.createElement('span')
      dot.dataset.current = String(index === stepIndex)
      return dot
    }))
    $('#tour-dots').hidden = introMode
    $('#tour-back').hidden = introMode
    $('#tour-back').disabled = introMode || stepIndex === 0
    $('#tour-skip').textContent = introMode ? 'Close' : 'Skip tour'
    $('#tour-next').textContent = introMode ? 'Start tour →' : stepIndex === tour.steps.length - 1 ? 'Done ✓' : 'Next →'
  }

  function open(requestedRole, trigger, showIntro) {
    role = Object.hasOwn(tours, requestedRole) ? requestedRole : 'shop'
    stepIndex = 0
    introMode = showIntro
    opener = trigger
    renderStep()
    dialog.showModal()
    $('#tour-heading').focus({ preventScroll: true })
  }
  function finishTour() { if (dialog.open) dialog.close() }
  $('#tour-close').addEventListener('click', finishTour)
  $('#tour-skip').addEventListener('click', finishTour)
  $('#tour-back').addEventListener('click', () => { if (stepIndex > 0) { stepIndex--; renderStep(); $('#tour-heading').focus({ preventScroll: true }) } })
  $('#tour-next').addEventListener('click', () => {
    if (introMode) { introMode = false; renderStep(); $('#tour-heading').focus({ preventScroll: true }); return }
    if (stepIndex === tours[role].steps.length - 1) return finishTour()
    stepIndex++; renderStep(); $('#tour-heading').focus({ preventScroll: true })
  })
  dialog.addEventListener('click', event => { if (event.target === dialog) finishTour() })
  dialog.addEventListener('close', () => { if (opener?.isConnected) opener.focus({ preventScroll: true }); opener = null })
  return Object.freeze({
    openWorkspaceTour: (requestedRole, trigger) => open(requestedRole, trigger, false),
    openWorkspaceIntro: (requestedRole, trigger) => open(requestedRole, trigger, true)
  })
}

const tour = () => getOrCreateSingleton('workspace-tour', initializeWorkspaceTour)
export function openWorkspaceTour(requestedRole, trigger) { return tour().openWorkspaceTour(requestedRole, trigger) }
export function openWorkspaceIntro(requestedRole, trigger) { return tour().openWorkspaceIntro(requestedRole, trigger) }
