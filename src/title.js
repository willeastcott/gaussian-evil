// The title card: what is on screen while the scene loads, and the way in.
//
// A browser will not play sound, nor an iPhone say which way it is facing, until the visitor has
// clicked or tapped something. So the way in is a button, and everything that needs that click is
// started from it.

/**
 * @returns {object} progress(), ready() and dismiss().
 */
export function createTitle() {
    const root = document.getElementById('title');
    const bar = /** @type {HTMLElement} */ (root.querySelector('#progress i'));
    const enter = /** @type {HTMLButtonElement} */ (root.querySelector('#enter'));
    const note = root.querySelector('.note');
    let shown = 0;

    return {
        /** @param {number} fraction - How much of the download is done, 0..1. It never runs back. */
        progress(fraction) {
            shown = Math.max(shown, Math.min(1, fraction));
            bar.style.width = `${(shown * 100).toFixed(1)}%`;
        },

        /**
         * The scene is loaded and drawing: swap the bar for the way in.
         *
         * @param {string} advice - A line to go under the button.
         * @param {() => void} onEnter - Called inside the click, so it may start sound and ask
         * for the phone's orientation.
         */
        ready(advice, onEnter) {
            root.classList.add('ready');
            enter.disabled = false;
            note.textContent = advice;
            enter.addEventListener('click', () => {
                enter.disabled = true;
                onEnter();
            }, { once: true });
            enter.focus({ preventScroll: true });
        },

        /** @param {string} why - Nothing more is going to happen: say so where the advice goes. */
        fail(why) {
            root.classList.add('failed');
            note.textContent = why;
        },

        /** @param {boolean} [now] - Take the card away at once, without the fade. */
        dismiss(now = false) {
            if (now) {
                root.hidden = true;
                return;
            }
            root.classList.add('gone');
            root.addEventListener('transitionend', (e) => {
                if (e.target === root) root.hidden = true;
            });
        }
    };
}
