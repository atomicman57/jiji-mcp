# Feature coverage

## Verified Grokbot buying workflow

The observed workflow searches across multiple listings, compares new/used asking prices, recommends resale prices, shortlists sellers, contacts them on Jiji, reads replies, retrieves individual seller phone numbers, and prepares handoffs to a separately authorized WhatsApp agent.

| Feature                                         | MCP support                                              | Live verification status                                                          |
| ----------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Search, sort, price/region/category filters     | Search tool with bounded results                         | Search/detail endpoints previously verified; companion path requires a live check |
| Multiple search pages                           | Response-provided pagination cursor                      | Automated                                                                         |
| Description, attributes, images, seller signals | Listing details                                          | Automated and direct Jiji endpoint inspection                                     |
| Compare sellers and prices                      | Compare listings                                         | Automated                                                                         |
| New/used asking-price and resale research       | Market-price sample plus ordinary query/pagination tools | Automated; asking prices are not completed sales                                  |
| Selected seller phone                           | Single-contact tool with stated purchase purpose         | Fixture tested; no bulk contact tool                                              |
| WhatsApp handoff                                | Exact listing, recipient and proposed message package    | Fixture tested; sends nothing itself                                              |
| Existing Jiji inbox and replies                 | Conversation tools                                       | Current Jiji DOM inspected; companion authenticated test pending                  |
| Jiji seller outreach/negotiation                | Prepare message and local approval                       | Approval/idempotency tested; no real seller message sent during development       |
| Saved listings                                  | Read existing saved list                                 | Implemented; authenticated live test pending                                      |
| Login                                           | Dedicated Chrome profile, direct Jiji login              | Extension-free browser launch verified; account login still needs completion      |
| ChatGPT/Codex/Claude/Grokbot                    | Local stdio and remote OAuth                             | Each app's installation and live test must be recorded individually               |

## Other Jiji features: not claimed as implemented

| Platform area                                                     | Current gap                                                                       |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Posting, editing, renewing, closing/deleting your adverts         | Not implemented                                                                   |
| Favourite add/remove and saved-search changes                     | Read-only saved-list support; mutations not implemented                           |
| Native offers / Request call back                                 | Not implemented; exact text can be prepared in chat for owner review              |
| Chat image/audio attachments, stickers, block/report/spam actions | Text chat only                                                                    |
| Seller feedback submissions and moderation actions                | Not implemented                                                                   |
| Notification management                                           | Not implemented                                                                   |
| Premium promotions, balance, billing and payments                 | Not implemented                                                                   |
| Account/profile settings, password change and account deletion    | Managed directly on Jiji                                                          |
| Automatic scheduled monitoring                                    | Agent-side feature, not started by this MCP                                       |
| Sending messages between Grokbot agents                           | Handoff data is available; messaging remains the host agent's authorized workflow |

This is a coverage map, not a claim of complete platform support. User-interface and endpoint changes can invalidate a feature until reverified.
