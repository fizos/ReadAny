"""Run with the installed optional engine's Python; no network or credentials."""
import importlib.util
import json
import logging
import subprocess
import sys
from pathlib import Path
import tempfile
import unittest
import pymupdf

spec = importlib.util.spec_from_file_location('worker', Path(__file__).with_name('worker.py'))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class PdfBoundaryTests(unittest.TestCase):
    @staticmethod
    def _font_dir():
        return Path(__file__).resolve().parents[1] / 'pdf-offline' / 'assets' / 'fonts'

    @staticmethod
    def _record(name, level, message='test'):
        return logging.LogRecord(name, level, __file__, 1, message, (), None)

    @staticmethod
    def _render(page):
        """Return the visible page raster, including its crop and rotation."""
        pixmap = page.get_pixmap(matrix=pymupdf.Matrix(1, 1), alpha=False)
        return pixmap.width, pixmap.height, bytes(pixmap.samples)

    @staticmethod
    def _assert_pixels_equal_outside(source, target, excluded_rects):
        source_width, source_height, source_samples = source
        target_width, target_height, target_samples = target
        if (source_width, source_height) != (target_width, target_height):
            raise AssertionError(f'page raster dimensions changed: {(source_width, source_height)} != '
                                 f'{(target_width, target_height)}')
        channels = 3
        differences = 0
        for y in range(source_height):
            for x in range(source_width):
                point = pymupdf.Point(x + 0.5, y + 0.5)
                if any(rect.contains(point) for rect in excluded_rects):
                    continue
                offset = (y * source_width + x) * channels
                if source_samples[offset:offset + channels] != target_samples[offset:offset + channels]:
                    differences += 1
        if differences:
            raise AssertionError(f'{differences} pixels changed outside source/target text masks')

    @staticmethod
    def _assert_glyphs_within(page, allowed_rects):
        for span in page.get_texttrace():
            if span.get('type') == 3:
                continue
            for _, _, _, box in span['chars']:
                glyph = pymupdf.Rect(box)
                if glyph.is_empty or glyph.is_infinite:
                    continue
                inside = any((glyph & rect).get_area() >= glyph.get_area() * 0.5 for rect in allowed_rects)
                if not inside:
                    raise AssertionError(f'glyph outside expected text boxes: {list(glyph)}')

    @staticmethod
    def _make_source_page(book, rotation, crop):
        page = book.new_page(width=220, height=140)
        page.draw_rect(pymupdf.Rect(35, 25, 180, 115), color=(0, 0, 0), fill=(0.9, 0.9, 0.9))
        page.draw_line((35, 25), (180, 115), color=(0, 0, 0), width=1)
        # The path itself is Unicode; keep the glyph assertion portable across
        # the built-in Helvetica encoding used by the offline runtime.
        page.insert_text((55, 62), 'Selected page', fontsize=14, color=(0, 0, 0))
        page.set_cropbox(pymupdf.Rect(*crop))
        page.set_rotation(rotation)
        return page

    def test_worker_rejects_invalid_pages_without_cache(self):
        with tempfile.TemporaryDirectory(prefix='ReadAny 中文 ') as directory:
            root = Path(directory)
            for case, expected in [('blank', 'no-text'), ('range', 'page'), ('encrypted', 'encrypted')]:
                with self.subTest(case=case):
                    source = root / f'{case}.pdf'
                    with pymupdf.open() as pdf:
                        pdf.new_page()
                        options = dict(encryption=pymupdf.PDF_ENCRYPT_AES_256, owner_pw='owner', user_pw='user') if case == 'encrypted' else {}
                        pdf.save(source, **options)
                    request = dict(action='translate', jobId=case, jobDir=str(root / case),
                                   filePath=str(source), page=2 if case == 'range' else 1,
                                   cacheDir=str(root / 'pages'))
                    result = subprocess.run([sys.executable, '-I', '-B', str(Path(worker.__file__).resolve())],
                                            input=json.dumps(request).encode(), capture_output=True, timeout=20)
                    events = [json.loads(line) for line in result.stdout.decode('utf-8').splitlines()]
                    self.assertEqual(result.returncode, 1)
                    self.assertEqual(events[-1]['code'], expected)
                    self.assertFalse(list((root / 'pages').glob('*.pdf')))

    def test_prepare_page_preserves_visible_pixels_for_rotations_and_crops(self):
        """The selected page is normalized to origin-zero without changing pixels."""
        with tempfile.TemporaryDirectory(prefix='ReadAny 中文 ') as directory:
            root = Path(directory)
            for rotation in (0, 90, 180, 270):
                for crop in ((0, 0, 220, 140), (25, 15, 195, 125)):
                    with self.subTest(rotation=rotation, crop=crop):
                        output = root / f'输出-{rotation}-{crop[0]}.pdf'
                        with pymupdf.open() as source:
                            source.new_page().insert_text((60, 80), 'Wrong page')
                            selected = self._make_source_page(source, rotation, crop)
                            source_raster = self._render(selected)
                            source_glyphs, source_outside = worker.page_text_bounds(selected)
                            geometry, baseline_outside = worker.prepare_page(source, 1, output)
                        self.assertGreater(source_glyphs, 0)
                        self.assertAlmostEqual(baseline_outside, source_outside, places=6)
                        with pymupdf.open(output) as result:
                            self.assertEqual(len(result), 1)
                            normalized = result[0]
                            self.assertEqual(normalized.rotation, 0)
                            self.assertEqual(list(normalized.cropbox), [0, 0, normalized.rect.width, normalized.rect.height])
                            self.assertIn('Selected page', normalized.get_text())
                            self.assertNotIn('Wrong page', normalized.get_text())
                            self.assertEqual(self._render(normalized), source_raster)
                            glyphs, outside = worker.page_text_bounds(normalized)
                        self.assertEqual(glyphs, source_glyphs)
                        self.assertLessEqual(outside, max(0.05, source_outside + 0.02) + 1e-6)
                        self.assertTrue(worker.valid_pdf(output, geometry, source_outside=source_outside))

    def test_prepare_page_handles_nonzero_mediabox_origin(self):
        """Translated MediaBox origins survive every supported rotation/crop."""
        with tempfile.TemporaryDirectory(prefix='ReadAny origin 中文 ') as directory:
            media = (40, 30, 260, 170)
            crops = {
                'full': (40, 0, 260, 140),
                'inner': (55, 10, 245, 130),
            }
            for rotation in (0, 90, 180, 270):
                for crop_name, crop in crops.items():
                    with self.subTest(rotation=rotation, crop=crop_name):
                        output = Path(directory) / f'非零原点-{rotation}-{crop_name}.pdf'
                        with pymupdf.open() as source:
                            page = source.new_page(width=220, height=140)
                            page.draw_rect(pymupdf.Rect(45, 35, 180, 115), color=(0, 0, 0), fill=(0.9, 0.9, 0.9))
                            page.draw_line((45, 35), (180, 115), color=(0, 0, 0), width=1)
                            page.insert_text((60, 62), 'Origin page', fontsize=14, color=(0, 0, 0))
                            page.set_mediabox(pymupdf.Rect(*media))
                            page.set_cropbox(pymupdf.Rect(*crop))
                            page.set_rotation(rotation)
                            source_raster = self._render(page)
                            source_glyphs, source_outside = worker.page_text_bounds(page)
                            geometry, baseline_outside = worker.prepare_page(source, 0, output)
                        self.assertGreater(source_glyphs, 0)
                        self.assertAlmostEqual(baseline_outside, source_outside, places=6)
                        with pymupdf.open(output) as result:
                            normalized = result[0]
                            self.assertEqual(normalized.rotation, 0)
                            self.assertAlmostEqual(normalized.rect.x0, 0, places=6)
                            self.assertAlmostEqual(normalized.rect.y0, 0, places=6)
                            self.assertIn('Origin page', normalized.get_text())
                            self.assertEqual(self._render(normalized), source_raster)
                            glyphs, outside = worker.page_text_bounds(normalized)
                        self.assertEqual(glyphs, source_glyphs)
                        self.assertLessEqual(outside, max(0.05, source_outside + 0.02) + 1e-6)
                        self.assertTrue(worker.valid_pdf(output, geometry, source_outside=source_outside))

    def test_extract_page_neighbors_uses_1_based_tail_and_head_with_utf8_bounds(self):
        with tempfile.TemporaryDirectory(prefix='ReadAny neighbors 中文 ') as directory:
            path = Path(directory) / '三页 fixture.pdf'
            with pymupdf.open() as document:
                first = document.new_page(width=300, height=160)
                first.insert_text((20, 30), 'FIRST-START ' + ('上一页😀 ' * 900), fontsize=8)
                current = document.new_page(width=300, height=160)
                current.insert_text((20, 30), 'CURRENT-ONLY', fontsize=12)
                last = document.new_page(width=300, height=160)
                last.insert_text((20, 30), 'NEXT-ONLY ' + ('下一页🚀 ' * 900), fontsize=8)
                document.save(path)
            with pymupdf.open(path) as document:
                middle = worker.extract_page_neighbors(document, 1)
                first_page = worker.extract_page_neighbors(document, 0)
                last_page = worker.extract_page_neighbors(document, 2)
            self.assertEqual(middle['before']['page'], 1)
            self.assertEqual(middle['after']['page'], 3)
            self.assertLessEqual(len(middle['before']['text'].encode('utf-8')), worker.MAX_PAGE_NEIGHBOR_BYTES)
            self.assertLessEqual(len(middle['after']['text'].encode('utf-8')), worker.MAX_PAGE_NEIGHBOR_BYTES)
            # Decode is a codepoint-boundary check; neither side may leak the target text.
            middle['before']['text'].encode('utf-8').decode('utf-8')
            middle['after']['text'].encode('utf-8').decode('utf-8')
            self.assertNotIn('CURRENT-ONLY', middle['before']['text'] + middle['after']['text'])
            self.assertIsNone(first_page['before']['page'])
            self.assertEqual(first_page['after']['page'], 2)
            self.assertEqual(first_page['after']['text'], 'CURRENT-ONLY')
            self.assertEqual(last_page['before']['page'], 2)
            self.assertIsNone(last_page['after']['page'])

    def test_extract_page_neighbors_empty_pages_and_extraction_errors_are_safe(self):
        with tempfile.TemporaryDirectory(prefix='ReadAny empty neighbors ') as directory:
            path = Path(directory) / 'blank-middle.pdf'
            with pymupdf.open() as document:
                document.new_page().insert_text((20, 30), 'BEFORE', fontsize=12)
                document.new_page()
                document.new_page().insert_text((20, 30), 'AFTER', fontsize=12)
                document.save(path)
            with pymupdf.open(path) as document:
                empty_middle = worker.extract_page_neighbors(document, 0)
                empty_last = worker.extract_page_neighbors(document, 2)
            self.assertIsNone(empty_middle['before']['page'])
            self.assertIsNone(empty_middle['after']['page'])
            self.assertEqual(empty_middle['after']['text'], '')
            self.assertIsNone(empty_last['after']['page'])
            self.assertIsNone(empty_last['before']['page'])

        class BrokenBook:
            def __len__(self):
                return 3

            def __getitem__(self, index):
                raise RuntimeError('synthetic extraction failure')

        self.assertEqual(worker.extract_page_neighbors(BrokenBook(), 1), {
            'before': {'page': None, 'text': ''},
            'after': {'page': None, 'text': ''},
        })

    def test_parse_slide_translation_rejects_invalid_keyed_json(self):
        lines = [{'id': '0', 'text': 'first'}, {'id': '1', 'text': 'second'}]
        valid = '[{"id":"0","text":"第一行"},{"id":"1","text":"第二行"}]'
        self.assertEqual(worker.parse_slide_translation(valid, lines), {'0': '第一行', '1': '第二行'})
        invalid = {
            'invalid-json': '[',
            'missing-key': '[{"id":"0"},{"id":"1","text":"ok"}]',
            'extra-key': '[{"id":"0","text":"ok","extra":"no"},{"id":"1","text":"ok"}]',
            'duplicate-id': '[{"id":"0","text":"one"},{"id":"0","text":"two"}]',
            'empty-text': '[{"id":"0","text":"ok"},{"id":"1","text":"   "}]',
            'newline-text': '[{"id":"0","text":"ok"},{"id":"1","text":"bad\\nline"}]',
        }
        for case, content in invalid.items():
            with self.subTest(case=case):
                with self.assertRaises(worker.EngineError) as raised:
                    worker.parse_slide_translation(content, lines)
                self.assertEqual(raised.exception.code, 'provider-response')

    def test_parse_positioned_list_translation_keeps_items_independent(self):
        rows = [{'id': 'list-0-0', 'text': 'first'}, {'id': 'list-0-1', 'text': 'second'}]
        valid = '[{"id":"list-0-0","text":"第一项"},{"id":"list-0-1","text":"第二项"}]'
        self.assertEqual(worker.parse_positioned_list_translation(valid, rows), {
            'list-0-0': '第一项', 'list-0-1': '第二项',
        })
        with self.assertRaises(worker.EngineError) as raised:
            worker.parse_positioned_list_translation(
                '[{"id":"list-0-0","text":"第一项\\n第二项"}]', rows)
        self.assertEqual(raised.exception.code, 'provider-response')

    def test_code_regions_detects_and_restores_filled_listing_body(self):
        with tempfile.TemporaryDirectory(prefix='ReadAny code region ') as directory:
            root = Path(directory)
            source = root / 'source.pdf'
            translated = root / 'translated.pdf'
            restored = root / 'restored.pdf'
            listing = pymupdf.Rect(30, 50, 270, 145)
            with pymupdf.open() as document:
                page = document.new_page(width=300, height=200)
                page.draw_rect(listing, color=None, fill=(0.95, 0.95, 0.95))
                page.insert_text((42, 72), 'def run(value):', fontsize=10)
                page.insert_text((54, 92), 'result = compute(value)', fontsize=10)
                page.insert_text((54, 112), 'return result', fontsize=10)
                document.save(source)
            with pymupdf.open(source) as document:
                regions = worker.code_regions(document[0])
            self.assertEqual(len(regions), 1)
            with pymupdf.open(source) as document:
                page = document[0]
                page.insert_text((54, 90), 'OVERLAPPED', fontsize=14, color=(1, 0, 0))
                document.save(translated)
            worker.restore_code_regions(source, translated, restored, regions)
            with pymupdf.open(restored) as document:
                text = document[0].get_text()
                self.assertIn('def run(value):', text)
                self.assertIn('return result', text)
                self.assertNotIn('OVERLAPPED', text)

    def test_toc_layout_keeps_entries_rows_and_page_columns_separate(self):
        """A table of contents is structured data, not one prose paragraph."""
        font_dir = self._font_dir()
        with tempfile.TemporaryDirectory(prefix='ReadAny toc ') as directory:
            root = Path(directory)
            source = root / 'contents.pdf'
            rendered = root / 'contents-translated.pdf'
            with pymupdf.open() as document:
                page = document.new_page(width=504, height=720)
                page.insert_text((176, 72), 'Table of Contents', fontsize=22)
                rows = [
                    (72, 'Preface. . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . .  ix'),
                    (96, '1. Model Serving and Optimization. . . . . . . . . . . . . . . . . . . . . . . . . . . . . . .  1'),
                    (112, '    Anatomy of a Model                                                        2'),
                    (128, '        Model Architecture                                                    4'),
                    (144, '        Model Data                                                            4'),
                    (160, '        Model Execution Code                                                  4'),
                    (176, '    Model Lifecycle: From Training to Serving                                 5'),
                    (192, '    Why Study Model Serving?                                                  8'),
                ]
                for y, text in rows:
                    page.insert_text((54, y + 130), text, fontsize=9)
                document.save(source)
            with pymupdf.open(source) as document:
                layout = worker.toc_layout(document[0])
                self.assertIsNotNone(layout)
                self.assertEqual(layout['heading']['text'], 'Table of Contents')
                self.assertEqual(len(layout['entries']), len(rows))
                self.assertEqual(layout['entries'][0]['page_label'], 'ix')
                self.assertEqual(layout['entries'][1]['page_label'], '1')
                self.assertGreater(layout['entries'][2]['fragments'][0]['rect'][0],
                                   layout['entries'][1]['fragments'][0]['rect'][0])
                translations = {
                    'toc-heading': ['目录'],
                    **{entry['id']: [f'条目 {index + 1}']
                       for index, entry in enumerate(layout['entries'])},
                }
            worker.render_toc(source, rendered, layout, translations, font_dir)
            with pymupdf.open(rendered) as document:
                text = document[0].get_text().replace('\xa0', ' ')
                self.assertIn('目录', text)
                self.assertIn('条目 1', text)
                self.assertIn('条目 8', text)
                self.assertNotIn('Preface', text)
                self.assertNotIn('Model Serving and Optimization', text)
                # The page column is source-owned: it must remain separate from
                # translated titles and still contain the original labels.
                self.assertIn('ix', text)
                self.assertIn('8', text)
                self.assertTrue(worker.valid_pdf(rendered, [list(document[0].mediabox),
                                                            list(document[0].cropbox), 0]))

    def test_toc_layout_rejects_normal_numbered_prose(self):
        with tempfile.TemporaryDirectory(prefix='ReadAny non toc ') as directory:
            path = Path(directory) / 'prose.pdf'
            with pymupdf.open() as document:
                page = document.new_page(width=504, height=720)
                for index in range(12):
                    page.insert_text((54, 70 + index * 26),
                                     f'{index + 1}. This is normal numbered prose with no page column.', fontsize=10)
                document.save(path)
            with pymupdf.open(path) as document:
                self.assertIsNone(worker.toc_layout(document[0]))

    def test_slide_cache_key_is_separate_from_normalized_pdf_key(self):
        request = {
            'page': 89,
            'targetLang': 'zh-CN',
            'baseUrl': 'https://example.invalid/v1',
            'model': 'test-model',
            'profileId': 'default',
        }
        normal = worker.cache_key(request, 'source-hash', normalized=True)
        slide = worker.cache_key(request, 'source-hash', normalized=True, slide=True)
        self.assertNotEqual(slide, normal)
        self.assertEqual(slide, worker.cache_key(request, 'source-hash', normalized=True, slide=True))

    def test_toc_cache_key_is_separate_from_normal_and_slide_layouts(self):
        request = {
            'page': 5,
            'targetLang': 'zh-CN',
            'baseUrl': 'https://example.invalid/v1',
            'model': 'test-model',
            'profileId': 'default',
        }
        normal = worker.cache_key(request, 'contents-source', normalized=True)
        slide = worker.cache_key(request, 'contents-source', normalized=True, slide=True)
        toc = worker.cache_key(request, 'contents-source', normalized=True, toc=True)
        self.assertNotEqual(toc, normal)
        self.assertNotEqual(toc, slide)
        self.assertEqual(toc, worker.cache_key(request, 'contents-source', normalized=True, toc=True))

    def test_parse_toc_translation_rejects_merged_or_partial_entries(self):
        items = [
            {'id': 'toc-heading', 'fragments': [{'text': 'Table of Contents'}]},
            {'id': 'toc-0', 'fragments': [{'text': 'First line'}, {'text': 'continuation'}]},
        ]
        valid = ('[{"id":"toc-heading","texts":["目录"]},'
                 '{"id":"toc-0","texts":["第一行","续行"]}]')
        self.assertEqual(worker.parse_toc_translation(valid, items), {
            'toc-heading': ['目录'], 'toc-0': ['第一行', '续行'],
        })
        for payload in (
            '[{"id":"toc-heading","texts":["目录"]}]',
            '[{"id":"toc-heading","texts":["目录"]},{"id":"toc-0","texts":["合并成一行"]}]',
            '[{"id":"toc-heading","texts":["目录"]},{"id":"toc-0","texts":["第一行","续\n行"]}]',
        ):
            with self.subTest(payload=payload):
                with self.assertRaises(worker.EngineError) as raised:
                    worker.parse_toc_translation(payload, items)
                self.assertEqual(raised.exception.code, 'provider-response')

    def test_render_normalized_slide_page_89_preserves_code_and_graphics(self):
        """Render a rotated 89th-page slide with 33 deterministic translations."""
        font_dir = self._font_dir()
        self.assertTrue((font_dir / 'GoNotoKurrent-Regular.ttf').is_file())
        with tempfile.TemporaryDirectory(prefix='ReadAny slide 中文 ') as directory:
            root = Path(directory)
            source = root / 'source-89.pdf'
            selected = root / 'normalized-page-89.pdf'
            rendered = root / 'translated-page-89.pdf'
            # Author the visible slide in its natural landscape coordinate space,
            # then encode it as a portrait MediaBox with a matching page rotation.
            # This mirrors the representation used by real rotated slide PDFs while
            # retaining horizontal text after prepare_page normalization.
            with pymupdf.open() as artwork:
                slide = artwork.new_page(width=720, height=405)
                slide.draw_rect(pymupdf.Rect(0, 0, 720, 405), color=(0.05, 0.1, 0.2),
                                fill=(0.92, 0.95, 1.0))
                slide.draw_line((12, 75), (708, 75), color=(0.1, 0.2, 0.7), width=3)
                image = pymupdf.Pixmap(pymupdf.csRGB, 24, 24, bytes([210, 50, 50]) * (24 * 24), 0)
                slide.insert_image(pymupdf.Rect(620, 90, 680, 150), pixmap=image)
                for index in range(33):
                    slide.insert_text((45, 105 + index * 8), f'Prose line {index:02d}',
                                      fontname='cour', fontsize=6,
                                      color=(0.05, 0.05, 0.1))
                slide.insert_text((45, 390), 'const keep = "KEEP";',
                                  fontname='cour', fontsize=7,
                                  color=(0.05, 0.05, 0.1))
                with pymupdf.open() as book:
                    for _ in range(88):
                        book.new_page(width=100, height=100)
                    page = book.new_page(width=405, height=720)
                    page.show_pdf_page(page.rect, artwork, 0, rotate=90)
                    page.set_rotation(90)
                    book.save(source)
                    self.assertEqual(len(book), 89)
                    geometry, source_outside = worker.prepare_page(book, 88, selected)
            with pymupdf.open(selected) as prepared:
                normalized = prepared[0]
                lines = worker.slide_lines(normalized)
                self.assertEqual(len(lines), 33)
                self.assertTrue(all('Prose line' in line['text'] for line in lines))
                self.assertFalse(any('const keep' in line['text'] for line in lines))
                source_text = normalized.get_text().replace('\xa0', ' ')
                self.assertIn('Prose line 00', source_text)
                self.assertIn('const keep', source_text)
                source_raster = self._render(normalized)
                source_blocks = normalized.get_text('dict')['blocks']
                code_rect = next(pymupdf.Rect(*block['bbox']) for block in source_blocks
                                 if 'const keep' in ''.join(span['text'] for line in block.get('lines', [])
                                                             for span in line.get('spans', [])).replace('\xa0', ' '))
                translations = {line['id']: f'Translated line {int(line["id"]):02d}' for line in lines}
            worker.render_slide(selected, rendered, lines, translations, font_dir)
            with pymupdf.open(rendered) as output:
                output_page = output[0]
                output_text = output_page.get_text().replace('\xa0', ' ')
                self.assertNotIn('Prose line', output_text)
                self.assertIn('const keep', output_text)
                self.assertIn('KEEP', output_text)
                output_raster = self._render(output_page)
                # Allow the expected source and replacement glyph regions to differ,
                # while requiring the colored background, vector line, and image to
                # remain pixel-identical everywhere else.
                text_masks = [pymupdf.Rect(rect.x0 - 2, rect.y0 - 2, rect.x1 + 2, rect.y1 + 2)
                              for rect in [pymupdf.Rect(*line['rect']) for line in lines]]
                self._assert_pixels_equal_outside(source_raster, output_raster, text_masks)
                # GoNoto's logical glyph boxes include extra ascent/descent;
                # those are not ink bounds. The exact raster comparison above
                # checks visible overflow; separately check page-level geometry.
                glyphs, outside = worker.page_text_bounds(output_page)
                self.assertGreater(glyphs, 0)
                self.assertLessEqual(outside, 0.05)
            self.assertTrue(worker.valid_pdf(rendered, geometry, source_outside=source_outside))

    def test_slide_lines_rejects_vertical_text(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'vertical.pdf'
            with pymupdf.open() as artwork:
                slide = artwork.new_page(width=720, height=405)
                slide.insert_text((45, 100), 'Vertical candidate', fontsize=10)
                with pymupdf.open() as document:
                    page = document.new_page(width=405, height=720)
                    page.show_pdf_page(page.rect, artwork, 0, rotate=90)
                    page.set_rotation(90)
                    document.save(path)
            with pymupdf.open(path) as document:
                self.assertEqual(worker.slide_lines(document[0]), [])

    def test_translation_failure_handler_ignores_recoverable_batch_messages(self):
        ledger = {'failed': False, 'error_code': None}
        handler = worker.TranslationFailureHandler(ledger)
        handler.emit(self._record('babeldoc.il_translator_llm_only', logging.WARNING, 'batch fallback'))
        handler.emit(self._record('babeldoc.il_translator_llm_only', logging.ERROR, 'batch parse fallback'))
        self.assertFalse(ledger['failed'])
        self.assertIsNone(ledger['error_code'])

    def test_translation_failure_handler_marks_terminal_paragraph_error(self):
        ledger = {'failed': False, 'error_code': None}
        handler = worker.TranslationFailureHandler(ledger)
        handler.emit(self._record('babeldoc.paragraph.il_translator', logging.ERROR, 'terminal paragraph'))
        self.assertTrue(ledger['failed'])
        self.assertIsNone(ledger['error_code'])

    def test_translation_failure_handler_preserves_transport_failure(self):
        ledger = {'failed': True, 'error_code': 'provider-timeout'}
        handler = worker.TranslationFailureHandler(ledger)
        handler.emit(self._record('babeldoc.il_translator_llm_only', logging.ERROR, 'recoverable batch error'))
        self.assertTrue(ledger['failed'])
        self.assertEqual(ledger['error_code'], 'provider-timeout')

    def test_translation_failure_handler_ignores_unrelated_logger_error(self):
        ledger = {'failed': False, 'error_code': None}
        handler = worker.TranslationFailureHandler(ledger)
        handler.emit(self._record('babeldoc.layout', logging.ERROR, 'unrelated error'))
        self.assertFalse(ledger['failed'])
        self.assertIsNone(ledger['error_code'])

    def test_valid_pdf_rejects_most_text_off_canvas(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'mostly-off-canvas.pdf'
            with pymupdf.open() as document:
                page = document.new_page(width=220, height=100)
                page.insert_text((205, 50), 'A' * 80, fontsize=12)
                document.save(output)
            geometry = [[0, 0, 220, 100], [0, 0, 220, 100], 0]
            with pymupdf.open(output) as document:
                glyphs, outside = worker.page_text_bounds(document[0])
            self.assertGreater(glyphs, 0)
            self.assertGreater(outside, 0.05)
            self.assertFalse(worker.valid_pdf(output, geometry, source_outside=0.0))

    def test_valid_pdf_allows_small_clipped_portion(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'small-clip.pdf'
            with pymupdf.open() as document:
                page = document.new_page(width=220, height=100)
                page.insert_text((20, 50), 'This text stays inside the page', fontsize=12)
                page.insert_text((219, 50), 'x', fontsize=12)
                document.save(output)
            geometry = [[0, 0, 220, 100], [0, 0, 220, 100], 0]
            with pymupdf.open(output) as document:
                glyphs, outside = worker.page_text_bounds(document[0])
            self.assertGreater(glyphs, 0)
            self.assertLessEqual(outside, 0.05)
            self.assertTrue(worker.valid_pdf(output, geometry, source_outside=0.0))

    def test_valid_pdf_uses_source_relative_outside_baseline(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'source-clipped.pdf'
            with pymupdf.open() as document:
                page = document.new_page(width=220, height=100)
                for index in range(9):
                    page.insert_text((20 + index * 18, 50), 'A', fontsize=12)
                page.insert_text((500, 50), 'A', fontsize=12)
                document.save(output)
            geometry = [[0, 0, 220, 100], [0, 0, 220, 100], 0]
            with pymupdf.open(output) as document:
                glyphs, source_outside = worker.page_text_bounds(document[0])
            self.assertGreaterEqual(glyphs, 10)
            self.assertGreater(source_outside, 0.05)
            self.assertFalse(worker.valid_pdf(output, geometry, source_outside=0.0))
            self.assertTrue(worker.valid_pdf(output, geometry, source_outside=source_outside))

    def test_normalized_cache_key_is_revisioned_without_changing_legacy_key(self):
        request = {
            'page': 1,
            'targetLang': 'zh-CN',
            'baseUrl': 'https://example.invalid/v1',
            'model': 'test-model',
            'profileId': 'default',
        }
        legacy = worker.cache_key(request, 'source-hash')
        self.assertEqual(legacy, worker.cache_key(request, 'source-hash', normalized=False))
        normalized = worker.cache_key(request, 'source-hash', normalized=True)
        self.assertNotEqual(normalized, legacy)
        self.assertEqual(normalized, worker.cache_key(request, 'source-hash', normalized=True))

    def test_corrupted_multpage_and_oversize_results(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'bad.pdf'
            output.write_bytes(b'%PDF invalid')
            geometry = [[0, 0, 595, 842], [0, 0, 595, 842], 0]
            self.assertFalse(worker.valid_pdf(output, geometry))
            with pymupdf.open() as source:
                source.new_page()
                source.new_page()
                source.save(output)
            self.assertFalse(worker.valid_pdf(output, geometry))
            with output.open('wb') as stream:
                stream.truncate(worker.MAX_PDF + 1)
            self.assertFalse(worker.valid_pdf(output, geometry))


if __name__ == '__main__':
    unittest.main()
