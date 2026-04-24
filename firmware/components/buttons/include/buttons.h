/**
 * @file buttons.h
 * @brief Interrupt-driven button handler for Vellum.
 */

#pragma once

#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    BUTTON_ACTION_NONE,
    BUTTON_ACTION_REQUEST_RENDER,  /**< Button 1: wake and request fresh render */
    BUTTON_ACTION_SEND_REPORT,     /**< Button 2: send issue report */
    BUTTON_ACTION_ENTER_SOFTAP,    /**< Button 3: held 5s → SoftAP mode */
} button_action_t;

/** Initialize button GPIOs with interrupt-driven detection. */
void buttons_init(void);

/** Poll for a completed button action. Resets after reading. */
button_action_t buttons_poll(void);

/** Check if Button 3 is currently held down. */
bool buttons_is_button3_held(void);

/** Create a bitmask of button GPIOs for deep sleep wake configuration. */
uint64_t buttons_get_wake_mask(void);

#ifdef __cplusplus
}
#endif
