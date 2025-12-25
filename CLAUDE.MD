# CLAUDE.MD - PDFLokal Project Guide

This file helps AI assistants understand and work with the PDFLokal project effectively.

## Project Overview

**PDFLokal** is a 100% client-side PDF and image manipulation tool designed for Indonesian users. All processing happens in the browser - no files are ever uploaded to a server.

- **Language**: Indonesian (UI text, documentation, copy)
- **Target Users**: Indonesian users who need privacy-focused PDF/image tools
- **Key Principle**: Privacy first - everything runs client-side
- **Tech Philosophy**: Vanilla JS, minimal dependencies, no build step

## Core Architecture

### Technology Stack

- **Vanilla HTML/CSS/JavaScript** - No frameworks, no build process
- **pdf-lib** - PDF manipulation (merge, split, edit, etc.)
- **PDF.js** (Mozilla) - PDF rendering and thumbnail generation
- **Signature Pad** - Digital signature capture
- **Canvas API** - Image processing and manipulation

### File Structure

```
pdflokal/
├── index.html      # Main application - all PDF/image tools
├── dukung.html     # Donation/support page
├── style.css       # All application styles
├── app.js          # All application logic
├── images/         # UI assets and icons
└── README.md       # User-facing documentation
```

### Single-Page Architecture

The entire application is in `index.html`. Features are organized as:
- Separate sections/modals for each tool (merge, split, compress, etc.)
- JavaScript in `app.js` handles all tool logic
- All styles in single `style.css` file

## Key Features

### PDF Tools
- Merge, split, compress, rotate PDFs
- Edit (whiteout, add text, signatures)
- Page management (reorder, delete, extract)
- PDF to image conversion
- Protect/unlock with passwords
- Add watermarks and page numbers
- Crop pages

### Image Tools
- Compress images with quality control
- Resize with aspect ratio lock
- Format conversion (JPG ↔ PNG ↔ WebP)
- Image to PDF conversion

## Development Guidelines

### 1. Language and Localization
- **All UI text MUST be in Indonesian** (Bahasa Indonesia)
- Use informal, friendly tone ("kamu" not "anda")
- Follow existing terminology in the codebase
- Error messages should be clear and in Indonesian

### 2. Client-Side Only Rule
- **CRITICAL**: All features must run 100% in the browser
- Never add server-side dependencies
- File processing must use browser APIs and existing libraries
- No external API calls for core functionality

### 3. Code Style
- Use vanilla JavaScript (ES6+)
- Avoid adding new npm dependencies unless absolutely necessary
- Keep code simple and readable
- Maintain consistency with existing code style
- Comment complex logic in Indonesian or English

### 4. Performance Considerations
- Target file sizes: up to 50MB comfortably
- Optimize for mobile and desktop browsers
- Test with large files before committing
- Consider memory usage for batch operations

### 5. Browser Compatibility
- Support modern browsers (Chrome, Firefox, Safari, Edge)
- Minimum ES6+ support required
- Test responsive design on mobile viewports
- Gracefully handle browser limitations

## Common Development Tasks

### Adding a New PDF Tool

1. Add UI section/modal in `index.html`
2. Add tool logic in `app.js`
3. Style in `style.css`
4. Update README.md features list
5. Test with various PDF types and sizes
6. Ensure error handling is in place

### Adding Image Processing Feature

1. Use Canvas API for processing
2. Maintain quality/compression controls
3. Support drag & drop and file selection
4. Show previews where appropriate
5. Test with different image formats

### Modifying Existing Features

1. Read the existing code carefully
2. Test before and after changes
3. Ensure no regressions in other features
4. Maintain Indonesian UI text
5. Update documentation if needed

## Important Notes

### File Processing Limitations

- **PDF Compression**: Only compresses images within PDFs, not PDF structure
- **Large Files**: Files >50MB may be slow or crash on some devices
- **Complex PDFs**: Encrypted PDFs or special fonts may not process correctly
- **Browser Memory**: Client-side processing is limited by browser memory

### Future Features (Require Server)

These features are **NOT** currently in scope (need server-side processing):
- PDF ↔ Word conversion
- PDF ↔ Excel conversion
- OCR (text recognition)

Do not implement these without discussing server architecture first.

## Libraries and Dependencies

### pdf-lib
- Used for: PDF manipulation (merge, split, edit, add pages, etc.)
- Loaded from CDN in production
- Fully client-side

### PDF.js
- Used for: Rendering PDFs, generating thumbnails
- Mozilla's official PDF rendering library
- Loaded from CDN

### Signature Pad
- Used for: Digital signature capture
- Canvas-based signature drawing

## Testing Checklist

Before committing changes:

- [ ] Test in Chrome, Firefox, and Safari
- [ ] Test on mobile viewport (responsive design)
- [ ] Test with small files (<1MB)
- [ ] Test with medium files (5-10MB)
- [ ] Test with large files (30-50MB)
- [ ] Verify all UI text is in Indonesian
- [ ] Check error handling works
- [ ] Ensure no console errors
- [ ] Verify files don't upload anywhere (check Network tab)

## Git Workflow

- Work on feature branches starting with `claude/`
- Write clear, descriptive commit messages
- Test thoroughly before pushing
- Keep commits focused and atomic

## Privacy and Security

**Critical Requirements**:
- Files must NEVER leave the user's device
- No analytics or tracking without explicit user consent
- No external API calls with user data
- Open source = users can verify privacy claims

## Support and Monetization

- Free to use, no login required
- Optional donations via `dukung.html`
- No paywalls or premium features
- Keep the tool accessible to everyone

## Quick Reference

### Main Files to Edit

- `index.html` - Add/modify tools UI
- `app.js` - Add/modify tool logic
- `style.css` - Update styles
- `README.md` - Update user documentation
- `dukung.html` - Donation page

### Don't Modify Without Good Reason

- Library CDN links (unless updating versions)
- Core privacy promises (client-side only)
- Indonesian language UI (don't translate to English)

## Questions to Ask Before Making Changes

1. Does this maintain client-side only processing?
2. Is the UI text in Indonesian?
3. Will this work on mobile browsers?
4. Have I tested with large files?
5. Is this consistent with existing code style?
6. Does this introduce new dependencies unnecessarily?

---

**Remember**: PDFLokal exists to give Indonesian users a private, free, easy-to-use PDF tool. Every change should support that mission.
