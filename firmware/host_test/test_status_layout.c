// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * The regression this exists for: with a 318px logo on a 480px panel and fixed
 * offsets, the error message was laid out at y=504 — entirely below the visible
 * area. Nothing caught it, because layout arithmetic was buried in LVGL code.
 *
 * Compiles the real components/vellum_display/status_layout.c.
 */
#include "unity_min.h"
#include "status_layout.h"

/* Real panel geometry. Logo heights are the pre-rendered 45%-of-height assets
 * (assets/render-logos.sh); e1003 keeps its existing 636px asset, which was
 * already 45.3%. */
#define E1001_H 480
#define E1001_LOGO 216
#define E1003_H 1404
#define E1003_LOGO 636
#define D1001_H 800
#define D1001_LOGO 360

/* LVGL Montserrat line_height is ~1.19x the nominal size. The tests use 1.25x
 * so they fail before the device does, never after. */
#define LINE(px) ((px) * 5 / 4)

void test_status_layout_logo_share_is_45_percent(void)
{
    /* If an asset is ever regenerated at the wrong size, this is the tripwire. */
    TEST_ASSERT_TRUE(E1001_LOGO * 100 / E1001_H >= 44 && E1001_LOGO * 100 / E1001_H <= 46);
    TEST_ASSERT_TRUE(E1003_LOGO * 100 / E1003_H >= 44 && E1003_LOGO * 100 / E1003_H <= 46);
    TEST_ASSERT_TRUE(D1001_LOGO * 100 / D1001_H >= 44 && D1001_LOGO * 100 / D1001_H <= 46);
}

void test_status_layout_content_stays_on_panel(void)
{
    /* content_top must leave usable room on every model — the old layout left
     * negative room on the 480px panels. */
    TEST_ASSERT_TRUE(status_layout_budget(E1001_H, E1001_LOGO, LINE(14)) > 0);
    TEST_ASSERT_TRUE(status_layout_budget(E1003_H, E1003_LOGO, LINE(24)) > 0);
    TEST_ASSERT_TRUE(status_layout_budget(D1001_H, D1001_LOGO, LINE(16)) > 0);

    TEST_ASSERT_TRUE(status_layout_content_top(E1001_H, E1001_LOGO, LINE(14)) < E1001_H);
    TEST_ASSERT_TRUE(status_layout_content_top(E1003_H, E1003_LOGO, LINE(24)) < E1003_H);
    TEST_ASSERT_TRUE(status_layout_content_top(D1001_H, D1001_LOGO, LINE(16)) < D1001_H);
}

/* The error screen's block is: icon row + gap + the wrapped message, both in the
 * same font. This mirrors the measurement display_show_error() performs, so a
 * change to one without the other shows up here. */
static bool error_block_fits(int height, int logo, int xs, int font, int lines, int gap)
{
    return status_layout_fits(height, logo, LINE(xs), 1, LINE(font), lines, LINE(font), gap);
}

void test_status_layout_one_line_message_fits_at_full_size(void)
{
    /* The common case must not need a font step-down on any model. */
    TEST_ASSERT_TRUE(error_block_fits(E1001_H, E1001_LOGO, 14, 48, 1, E1001_H / 40));
    TEST_ASSERT_TRUE(error_block_fits(E1003_H, E1003_LOGO, 24, 96, 1, E1003_H / 40));
    TEST_ASSERT_TRUE(error_block_fits(D1001_H, D1001_LOGO, 16, 48, 1, D1001_H / 40));
}

void test_status_layout_font_ladder_converges_on_every_model(void)
{
    /* The contract that matters: for a message of up to 3 wrapped lines, SOME
     * rung of font_lg → font_md → font_sm fits. The old code had no ladder at
     * all and drew font_lg off the bottom of a 480px panel. */
    const int e1001_ladder[] = {48, 24, 18};   /* panel_epaper.c, 480px short side */
    const int e1003_ladder[] = {96, 64, 48};   /* after step 2 raises these */
    const int d1001_ladder[] = {48, 32, 24};   /* panel_lcd.c */

    for (int lines = 1; lines <= 3; lines++) {
        bool any;

        any = false;
        for (int i = 0; i < 3; i++)
            any = any || error_block_fits(E1001_H, E1001_LOGO, 14, e1001_ladder[i], lines, E1001_H / 40);
        TEST_ASSERT_TRUE(any);

        any = false;
        for (int i = 0; i < 3; i++)
            any = any || error_block_fits(E1003_H, E1003_LOGO, 24, e1003_ladder[i], lines, E1003_H / 40);
        TEST_ASSERT_TRUE(any);

        any = false;
        for (int i = 0; i < 3; i++)
            any = any || error_block_fits(D1001_H, D1001_LOGO, 16, d1001_ladder[i], lines, D1001_H / 40);
        TEST_ASSERT_TRUE(any);
    }
}

void test_status_layout_rejects_what_does_not_fit(void)
{
    /* A 2-line message at font_lg genuinely overflows a 480px panel — the screen
     * MUST be told so, or it repeats the original bug. This is the assertion the
     * old absolute-offset layout could not make. */
    TEST_ASSERT_FALSE(error_block_fits(E1001_H, E1001_LOGO, 14, 48, 2, E1001_H / 40));
    /* …and the next rung down recovers it. */
    TEST_ASSERT_TRUE(error_block_fits(E1001_H, E1001_LOGO, 14, 24, 2, E1001_H / 40));
    /* The large panels have room for the same message at their largest font. */
    TEST_ASSERT_TRUE(error_block_fits(E1003_H, E1003_LOGO, 24, 96, 2, E1003_H / 40));
    TEST_ASSERT_TRUE(error_block_fits(D1001_H, D1001_LOGO, 16, 48, 2, D1001_H / 40));
}

void test_status_layout_is_monotonic_and_ordered(void)
{
    /* logo_top < identity < content_top, and a taller logo never raises the
     * content. */
    for (int h = 400; h <= 1500; h += 50) {
        int logo = h * 45 / 100;
        int top = status_layout_logo_top(h);
        int ident = status_layout_identity_top(h, logo);
        int content = status_layout_content_top(h, logo, LINE(16));
        TEST_ASSERT_TRUE(top < ident);
        TEST_ASSERT_TRUE(ident < content);
        TEST_ASSERT_TRUE(content <= h);
        TEST_ASSERT_TRUE(status_layout_content_top(h, logo + 40, LINE(16)) > content);
    }
}

void test_status_layout_never_reports_a_negative_budget(void)
{
    /* A pathological asset must clamp, not produce a negative height that a
     * caller might use as a size. */
    TEST_ASSERT_EQUAL_INT(0, status_layout_budget(480, 900, LINE(14)));
}

void run_status_layout_tests(void)
{
    RUN_TEST(test_status_layout_logo_share_is_45_percent);
    RUN_TEST(test_status_layout_content_stays_on_panel);
    RUN_TEST(test_status_layout_one_line_message_fits_at_full_size);
    RUN_TEST(test_status_layout_font_ladder_converges_on_every_model);
    RUN_TEST(test_status_layout_rejects_what_does_not_fit);
    RUN_TEST(test_status_layout_is_monotonic_and_ordered);
    RUN_TEST(test_status_layout_never_reports_a_negative_budget);
}
