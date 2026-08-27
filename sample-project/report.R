library(glue)
library(cli)
source("helpers.R")

user <- "  Ada  "
n <- 3

cat(glue("hi {user}"))
cat(glue("hello {label(user)}"))
cat(glue("you have {describe(n)}"))
cli::cli_alert_info("report ready for {label(user)}")
