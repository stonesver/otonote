import {installNavigationFeedback} from '../lib/navigation-feedback.mjs';
import {fallbackLoadingArt} from './loading-presentation.mjs';
import loadingCss from '../styles/loading-shell.css';
import transitionCss from '../styles/page-transitions.css';
import feedbackCss from '../styles/navigation-feedback.css';
const codeRoot=globalThis[Symbol.for('ournotes.code-root.v1')] || document.currentScript.dataset.codeRoot;
const art=globalThis[Symbol.for('ournotes.prerender.v1')]?.loadingArt
  ?? JSON.parse(document.querySelector('[data-loading-art]')?.textContent || '{}');
installNavigationFeedback({css:loadingCss+'\n'+transitionCss+'\n'+feedbackCss,
  art:{...fallbackLoadingArt(codeRoot),...art}});
