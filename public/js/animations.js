// GSAP Animations Configuration

document.addEventListener('DOMContentLoaded', () => {
    // Register ScrollTrigger
    if (typeof gsap !== 'undefined' && typeof ScrollTrigger !== 'undefined') {
        gsap.registerPlugin(ScrollTrigger);
        initAnimations();
    } else {
        console.warn('GSAP not loaded. Animations disabled.');
    }
});

function initAnimations() {
    // 1. Hover Effects on Cards
    const cards = document.querySelectorAll('.card, .glass-card, .module-card');
    cards.forEach(card => {
        card.addEventListener('mouseenter', () => {
            gsap.to(card, {
                y: -4,
                boxShadow: '0 12px 40px rgba(0, 0, 0, 0.12)', // var(--shadow-hover)
                duration: 0.3,
                ease: 'power2.out'
            });
        });

        card.addEventListener('mouseleave', () => {
            gsap.to(card, {
                y: 0,
                boxShadow: '0 4px 24px rgba(0, 0, 0, 0.04)', // var(--shadow-soft)
                duration: 0.3,
                ease: 'power2.out'
            });
        });
    });

    // 2. Fade-In on Load (Staggered)
    // Applies to sections, cards, and list items
    gsap.from('.section, .card, .glass-card, .list-group-item', {
        opacity: 0,
        y: 20,
        duration: 0.6,
        stagger: 0.05,
        ease: 'power2.out',
        delay: 0.1
    });

    // 3. Hover Buttons
    const buttons = document.querySelectorAll('.btn-primary, .btn-liquid');
    buttons.forEach(btn => {
        btn.addEventListener('mouseenter', () => {
            gsap.to(btn, {
                y: -2,
                boxShadow: '0 8px 24px rgba(0, 113, 227, 0.3)',
                duration: 0.3
            });
        });

        btn.addEventListener('mouseleave', () => {
            gsap.to(btn, {
                y: 0,
                boxShadow: '0 4px 12px rgba(0, 113, 227, 0.2)',
                duration: 0.3
            });
        });

        // Ripple Effect on Click
        btn.addEventListener('click', createRipple);
    });
}

// 4. Ripple Effect
function createRipple(event) {
    const button = event.currentTarget;
    const rect = button.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);

    const ripple = document.createElement('span');
    ripple.className = 'ripple';

    // Style ripple (should be in CSS but injecting here for self-containment if needed)
    ripple.style.position = 'absolute';
    ripple.style.borderRadius = '50%';
    ripple.style.background = 'rgba(255, 255, 255, 0.4)';
    ripple.style.pointerEvents = 'none';
    ripple.style.width = ripple.style.height = size + 'px';

    const x = event.clientX - rect.left - size / 2;
    const y = event.clientY - rect.top - size / 2;

    ripple.style.left = x + 'px';
    ripple.style.top = y + 'px';

    button.appendChild(ripple);

    gsap.to(ripple, {
        scale: 4,
        opacity: 0,
        duration: 0.6,
        ease: 'power2.out',
        onComplete: () => ripple.remove()
    });
}
